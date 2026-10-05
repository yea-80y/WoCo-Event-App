# Site builder

Organisers build multi-page websites in WoCo and publish them as **standalone Swarm
collections**, stored on Etherna - pages that need no server at page load and can be pointed at
by an ENS name.

Design background: [MULTI_PAGE_SITE_BUILDER.md](./MULTI_PAGE_SITE_BUILDER.md).
SEO and custom domains: [SEO_PLAN.md](./SEO_PLAN.md) (authoritative).

**Verified against `main` (94364b56) on 2026-10-05.**

---

## 1. The shape of it

```
  BUILDER                  PUBLISH                 DEPLOY                LIVE SITE
  #/creator/sites in  →  Site JSON written    →  dist-multisite/    →  a BZZ collection
  the platform app       to Swarm feeds          tarred + uploaded     on Etherna, with
  (Organiser area)                               with SITE_CONFIG      SITE_CONFIG baked in
                                                 injected              (no server at load)
```

Two things follow from "no server at page load", and they explain most of the design:

1. **The runtime bundle is baked into every published site.** `dist-multisite/` is tarred into
   the collection at deploy time. A change to the site runtime therefore reaches nobody until each
   organiser **re-publishes**.
2. **Configuration is injected, not fetched.** `window.SITE_CONFIG` (`SiteRuntimeConfig` in the
   schema) is written into the HTML at deploy time.

`MultiSiteApp.svelte` is the deployed-site shell; `MultiSiteBuilder.svelte` is the editor (tabs:
Template, Brand, Pages, Navigation, Events, Domain; Shop only when `shopAllowed`, which is off).
`#/build` is a legacy alias of `#/creator/sites`.

The single-event page builder (`SiteBuilder.svelte`, `POST /api/site/deploy`) is a separate path with
its own baked bundle, `dist-site/`; it is not covered here.

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
 ├── contact / socials
 └── subEnsLabel?              the site's woco.eth name, when claimed

Section.type = hero | richText | gallery | image | eventsGrid | featuredEvent
             | openingHours | map | contactForm | embed | productGrid
```

`siteDescription` and the logo (`logoSwarmRef`, also the `og:image`) live on `theme`.
`SITE_SCHEMA_VERSION = 1`.
Templates are `pub-venue-v1`, `nightlife-v1`, `clean-modern-v1`
(`newSiteFromTemplate()` in `packages/shared/src/site/templates.ts`).

---

## 3. Publishing: two steps, deliberately

```
POST /api/sites
  · writes the config feed entry + SiteEventsIndex in one request
    (concurrent writes, not a transaction)
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
  · tars dist-multisite/, uploads it as a BZZ collection (Etherna:
    the owner's own batch, else the shared platform batch as free hosting)
  · advances the per-site pointer feed (client-signed when the site is)
  · registers Etherna offers (anonymous reads) and whitelists the hashes
    on the WoCo gateway
  · checks the site's sub-ENS name still points at the feed (never writes it)
  · updates linked custom domains, re-upserts the directory entry
  → { contentHash, feedManifestHash, siteUrl, multisiteFeed?, subEns? }
```

They are separate because they fail differently. Publishing is a data write and is cheap to
retry; deploying uploads megabytes and touches the gateway. Splitting them means a failed deploy
does not lose the site.

The creator-directory upsert is **fire-and-forget on both steps** — a failure there is non-fatal,
because "your site exists but is missing from your list" is recoverable and "your site did not
publish" is not.

Write endpoints use the same EIP-712 session delegation as events, and the owner is stamped
**server-side from the verified parent address** — never from the request body. An ownership
read that cannot answer refuses (503) rather than treating the site as unclaimed (#181).

**Who may save, upload a logo or deploy:** a Stripe-verified organiser, or an owner with their
own live Etherna batch - checked on every gateway, before anything is stored
(`websiteStorageRefusal()`, owner decision 2026-10-02). The router's free-hosting check alone
covered only the Etherna fallback, which left the WoCo gateway path open. The builder always
targets the Etherna gateway; the gateway picker is gone (#617, #618).

---

## 4. Feeds

| Topic | Holds |
|---|---|
| `woco/site/config/{siteId}` | The `Site` JSON |
| `woco/site/pages/{siteId}` | The pages array — **split from config** to stay under one 4096-byte chunk |
| `woco/site/{siteId}/events` | `SiteEventsIndex` |
| `woco/site/creator/{address}[/pN]` | The creator's site directory, paged |
| `woco-multisite-{siteId}` | The per-site pointer → latest deployed collection hash |
| `woco-site-{eventId}` | The same kind of pointer for a single-event page, owned by the organiser's feed signer (#614) |

Derived in `packages/shared/src/site/topics.ts`, centralised so the server (writer) and the
deployed-site runtime (reader) cannot disagree about a string.

The platform-written pages (pointer, legacy config/pages, events index) are stamped where the site
lives - Etherna - so they expire with the content they anchor (`siteFeedDest()`, #48). The creator
directory is a platform feed on the WoCo batch.

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

Sites are stored on Etherna: on the owner's own Etherna batch when they have a live one, else on
the shared Etherna platform batch as **free hosting** (Stripe-verified organisers only, while
`FREE_HOSTING` is on - the default). Free hosting has a **100 MB quota per owner**
(`FREE_HOSTING_QUOTA_BYTES`), counted as each site's latest-deployment bytes
(`.data/storage-ledger.json`); over it, the deploy answers 413. Only free-hosted bytes count;
superseded refs stay in the ledger because they are still the garbage-collection record, but they
are not re-charged. A dead platform batch refuses the deploy (503, #610) rather than stamping into
a void.

That quota is the reason a stale `dist-multisite/` matters more than it looks: the deploy step
tars the **whole** directory, so dead hashed chunks from previous builds get baked into every
organiser's collection and charged against their quota.

Addressing options, in ascending order of niceness:

```
<gateway>/bzz/<contentHash>/     the raw collection - changes on every deploy; never shown to users
<label>.woco.eth.limo            a woco.eth name (Domain tab), pointed at the feed manifest
a custom domain                  see SEO_PLAN.md
```

A sub-ENS name is pointed once, at bind, by the holder's own signature; it follows the feed
manifest, so later publishes need no chain write and no prompt
([SUBENS_IDENTITY.md](./SUBENS_IDENTITY.md)). A publish shows at the name after about 5 minutes
(files spread from Etherna, then eth.limo's 300 s cache; #613, #624). eth.limo holds wildcard
certificates for `*.woco.eth.limo`, so a new name has no first-open certificate wait.

SEO metadata (`siteDescription`, `og:*`, `twitter:card`, with `ogImage` set to the logo's Swarm
ref) is injected at **deploy** time; `MultiSiteApp` then updates the meta description per page at
runtime. Not injected yet: `<title>` and a canonical (#70) - see SEO_PLAN.md.

---

## 7. Related

- [ARCHITECTURE.md](./ARCHITECTURE.md) — where this sits in the system
- [SWARM_DATA_MODEL.md](./SWARM_DATA_MODEL.md) — chunks, feeds, the gateway whitelist
- [SEO_PLAN.md](./SEO_PLAN.md) — **authoritative** on SEO and custom domains
- [SITE_EVENTS_CLIENT_SIGNED_HANDOVER.md](./SITE_EVENTS_CLIENT_SIGNED_HANDOVER.md) — why site
  events are client-signed
- [MULTI_PAGE_SITE_BUILDER.md](./MULTI_PAGE_SITE_BUILDER.md) — the original design record
