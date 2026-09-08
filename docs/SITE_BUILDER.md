# Site builder

Organisers build multi-page websites in WoCo and publish them as **standalone Swarm
collections** — pages that need no server at page load and can be pointed at by an ENS name.

Design background: [MULTI_PAGE_SITE_BUILDER.md](./MULTI_PAGE_SITE_BUILDER.md).
SEO and custom domains: [SEO_PLAN.md](./SEO_PLAN.md) (authoritative).

**Verified against `main` on 2026-09-08.**

---

## 1. The shape of it

```
  BUILDER                  PUBLISH                 DEPLOY                LIVE SITE
  #/build in the      →  Site JSON written    →  dist-multisite/    →  a BZZ collection
  platform app           to Swarm feeds          tarred + uploaded     on Swarm, with
                                                 with SITE_CONFIG      SITE_CONFIG baked in
                                                 injected              (no server at load)
```

Two things follow from "no server at page load", and they explain most of the design:

1. **The runtime bundle is baked into every published site.** `dist-multisite/` is tarred into
   the collection at deploy time. A change to the site runtime therefore reaches nobody until each
   organiser **re-publishes**.
2. **Configuration is injected, not fetched.** `window.SITE_CONFIG` (`SiteRuntimeConfig` in the
   schema) is written into the HTML at deploy time.

`MultiSiteApp.svelte` is the deployed-site shell; `MultiSiteBuilder.svelte` is the editor.

---

## 2. The schema is the source of truth

`packages/shared/src/site/types.ts`. Read it there rather than trusting a summary — but the shape
is:

```
Site
 ├── theme: ThemeTokens        palette, fonts, radius scale, logo size, nav style
 ├── nav:   NavItem[]
 ├── pages: Page[]
 │            └── sections: Section[]      a discriminated union
 └── contact / socials / SEO fields

Section = hero | rich-text | gallery | events-grid | featured-event
        | opening-hours | map | contact-form | embed | product-grid | image
```

`SITE_SCHEMA_VERSION = 1`. Templates are `pub-venue-v1`, `nightlife-v1`, `clean-modern-v1`
(`newSiteFromTemplate()` in `packages/shared/src/site/templates.ts`).

---

## 3. Publishing: two steps, deliberately

```
POST /api/sites
  · writes the config feed entry + SiteEventsIndex ATOMICALLY
  · WITH a site feed signer: config holds a platform-signed POINTER
    ({_woco_site_ptr, ownerAddress, siteFeedSigner}) and the CLIENT writes
    the Site body as its own chunk
  · WITHOUT one (legacy): the server writes the Site shell + pages itself,
    split across two feeds to stay under 4096 bytes
  · the events index stays PLATFORM-signed either way — it carries the
    per-event creatorFeedSigner consumed on the claim/payment path
  · upserts a SiteDirectoryEntry into the creator's directory feed

POST /api/sites/:id/deploy
  · injects SITE_CONFIG + SEO/PWA meta into the HTML
  · tars dist-multisite/, uploads it as a BZZ collection
  · writes the content hash to the per-site pointer feed
  · auto-whitelists the hashes on the gateway
  · re-upserts the directory entry
  → { contentHash, feedManifestHash, siteUrl }
```

They are separate because they fail differently. Publishing is a data write and is cheap to
retry; deploying uploads megabytes and touches the gateway. Splitting them means a failed deploy
does not lose the site.

The creator-directory upsert is **fire-and-forget on both steps** — a failure there is non-fatal,
because "your site exists but is missing from your list" is recoverable and "your site did not
publish" is not.

Write endpoints use the same EIP-712 session delegation as events, and the owner is stamped
**server-side from the verified parent address** — never from the request body.

---

## 4. Feeds

| Topic | Holds |
|---|---|
| `woco/site/config/{siteId}` | The `Site` JSON |
| `woco/site/pages/{siteId}` | The pages array — **split from config** to stay under one 4096-byte chunk |
| `woco/site/{siteId}/events` | `SiteEventsIndex` |
| `woco/site/creator/{address}[/pN]` | The creator's site directory, paged |
| `woco-multisite-{siteId}` | The per-site pointer → latest deployed collection hash |

Derived in `packages/shared/src/site/topics.ts`, centralised so the server (writer) and the
deployed-site runtime (reader) cannot disagree about a string.

**`woco-multisite-{siteId}` is different from the others.** It is a *real* bee sequence feed, not
one of our SOC content feeds, because gateways must resolve it via `/bzz/{feedManifestHash}` —
which is what a custom domain or an ENS contenthash points at. So its updates use bee's own
identifier scheme (`beeFeedUpdateIdentifier`), not `contentFeedSocIdentifier`. Client-owned sites
sign those updates with the owner's feed signer; legacy sites are platform-signed. Background:
[SWARM_DATA_MODEL.md § A SOC is immutable](./SWARM_DATA_MODEL.md#2-a-soc-is-immutable--so-how-is-a-feed-mutable).

---

## 5. Reading

**"My sites"** — `GET /api/sites/mine` reads the creator's Swarm directory. `localStorage`
`woco:my-sites` is a write-through cache seeded for instant paint; **the API is truth.**

> Route order matters: `GET /mine` must be registered **before** `GET /:id` in Hono, or "mine"
> matches as a siteId.

**Events on a deployed site** — `GET /api/sites/:id/events-full`, bundled into one response, with
three cache layers:

| Layer | Window |
|---|---|
| Server (`SITE_EVENTS_FULL_TTL_MS`) | 5 minutes |
| HTTP / CDN edge | `max-age=300, stale-while-revalidate=86400` |
| Client (`cache.ts` → `SITE_EVENTS`) | 2 hours, stale-while-revalidate |

Preview mode skips the cache.

A deployed site does therefore reach the API for *events* — the pages themselves need no server,
but a live event list is live data.

---

## 6. Hosting, quota and addressing

Sites are stored under the platform postage batch, with a **free-hosting quota** counted as
latest-deployment bytes per site (`.data/storage-ledger.json`). Only bytes on the shared platform
batch count against it; superseded refs stay in the ledger because they are still the
garbage-collection record, but they are not re-charged.

That quota is the reason a stale `dist-multisite/` matters more than it looks: the deploy step
tars the **whole** directory, so dead hashed chunks from previous builds get baked into every
organiser's collection and charged against their quota.

Addressing options, in ascending order of niceness:

```
gateway.woco-net.com/bzz/<contentHash>/     the raw collection
<label>.woco.eth.link                       an ENS name via contenthash
a custom domain                              see SEO_PLAN.md
```

SEO metadata (`siteDescription`, `og:*`, `twitter:card`, with `ogImage` set to the logo's Swarm
ref) is injected at **deploy** time; `MultiSiteApp` then updates the meta description per page at
runtime.

---

## 7. Related

- [ARCHITECTURE.md](./ARCHITECTURE.md) — where this sits in the system
- [SWARM_DATA_MODEL.md](./SWARM_DATA_MODEL.md) — chunks, feeds, the gateway whitelist
- [SEO_PLAN.md](./SEO_PLAN.md) — **authoritative** on SEO and custom domains
- [SITE_EVENTS_CLIENT_SIGNED_HANDOVER.md](./SITE_EVENTS_CLIENT_SIGNED_HANDOVER.md) — why site
  events are client-signed
- [MULTI_PAGE_SITE_BUILDER.md](./MULTI_PAGE_SITE_BUILDER.md) — the original design record
