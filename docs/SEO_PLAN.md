# SEO Plan — organiser websites + event pages

Decisions taken 2026-07-26. Supersedes ad-hoc SEO notes in NEXT.md "Deferred".
Issue #55 (schema.org/Event ld+json) predates this doc and is folded in below.

## Why this exists

Three-part SEO model we're building the product around (external course, "non-wanky SEO"):

1. **Meta title + description** — the advert in the search result.
2. **H1/H2 structure** — what the page is about, in the words people type.
3. **Links with descriptive anchor text** — discovery + meaning.

All three assume *one page = one URL = one search intent*. WoCo currently breaks that
assumption in the plumbing, so organiser copy quality is not the binding constraint yet.

## Verified current state (2026-07-26)

- Deployed sites ship `<title>Site</title>` — `apps/web/multi-site.html:6`. Deploy-time
  injection (`apps/server/src/routes/sites.ts:715-737`) writes `og:*`, `twitter:*` and
  `meta description` but **never `<title>`**. Real title is set only by JS at runtime
  (`MultiSiteApp.svelte:105`).
- **Hash routing** — `#/about`, `#/contact` (`MultiSiteApp.svelte:52-62`). Crawlers discard
  the fragment, so an N-page site is ONE indexable URL. Parts 1+2 above have nowhere to land.
- `Page.metaDescription` is defined (`packages/shared/src/site/types.ts:254`) and read at
  runtime (`MultiSiteApp.svelte:217`) but **has no editor field anywhere in the builder**.
- H1s are accidental: only `HeroSection.svelte:25` emits one. A page without a hero has no
  H1; `RichTextSection.svelte:14` turns a user's `# ` into a second H1. No warnings.
- **No canonical, no robots.txt, no sitemap.xml, no JSON-LD** anywhere.
- The bzz contentHash **changes on every republish** → the URL changes → indexing resets.
  A stable hostname in front is a precondition for any SEO at all.
- `packages/edge-proxy/` **does not exist**. `docs/CUSTOM_DOMAINS_PLAN.md` describes it; it
  was never built. Server half IS built: registry, `GET /api/domains/resolve/:hostname`
  (public), CNAME verification poller, `DomainLinker` UI, contentHash auto-update on deploy.
- eth.limo IS crawlable — `robots.txt` disallows only `/wiki/` paths; `woco.eth.limo` returns
  200, no `x-robots-tag: noindex`. ENS hosting is not an indexing dead end.

## Decisions

### D1 — Address ladder

| Tier | Status |
|---|---|
| Organiser's own DNS domain | **Recommended path.** Only tier where authority accrues to them. |
| Organiser's own ENS name | Supported. Their asset, their choice. |
| WoCo-issued ENS equivalent | Future. Not now. |
| WoCo-issued free subdomain | **Rejected** — see D2. |

### D2 — No WoCo-issued free subdomain tier

Rejected 2026-07-26. Reasons, strongest first:

1. Free subdomains on `woco-net.com` put anonymous hosting behind the **same registrable
   domain as `events-api.` and `gateway.`**. Safe Browsing / spam reputation acts at that
   level — one phishing site would poison our API and gateway.
2. Strictly worse SEO than the thing it substitutes for.
3. Adds wildcard certs, a namespace with squatting rules, and a takedown process.
4. Organisers serious enough to do SEO have a domain already.

### D3 — Sub-ENS dropped from the website builder entirely

WoCo-issued sub-ENS (`{label}.woco.eth`) is **removed from the multi-page site builder**.
Rationale: it built authority on `eth.limo` (a third-party shared root we don't control),
and multiplied one page across four URLs with no canonical to disambiguate.

**Kept elsewhere — do not remove:**

- **Profiles** (`ProfilePage.svelte:724`) — the name IS the identity primitive. EAS likes key
  off its namehash (`packages/shared/src/likes/subject.ts`). Removing breaks likes/following.
- **Event pages** (`EventForm.svelte:93`, `EventDomainPicker.svelte`) — deliberate USP: a
  personalised share URL beats a Skiddle/Fatsoma URL, and many organisers will have an event
  page and no website. See D4.

Accepted consequence: a website whose organiser has neither a DNS domain nor an ENS name has
no shareable address (only the deploy-mutable bzz URL). This is a deliberate quality bar.

### D4 — Event pages keep sub-ENS, and get real SEO anyway

Sharing and ranking are different jobs; the ENS name can do both.

- **Not chasing** head terms ("gigs manchester"). Skiddle/RA/Fatsoma win on domain authority
  and we cannot buy it.
- **Chasing** branded search ("lock tavern quiz night"), long-tail specifics, and above all
  **Google Event rich results** — driven by `schema.org/Event` JSON-LD, far less dependent on
  domain authority than blue links. This makes **#55 the highest-value SEO item on the board**.
- Data needed is already in `EventGeo` / `EventTag` (#37) and `PaymentConfig`.

### D5 — Custom domain must PROXY, never redirect

The worker fetches from the gateway server-side and returns bytes under the organiser's
hostname. Googlebot never sees a bzz URL. A 301/302 to the gateway hands indexing to us
instead of them and defeats the entire strategy.

### D6 — One CNAME path for everyone; no trial, no NS-migration funnel

**Verified Cloudflare for SaaS pricing (2026-07-26):** 100 custom hostnames included free on
Free/Pro/Business plans; **$0.10/month per hostname beyond 100**; certificates automatic at no
extra cost; ceiling 50,000. Source: developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/

At our scale this is ~free (1,000 organiser domains ≈ $90/month). The existing
`onCloudflare` / `trialExpiresAt` / `deactivated` machinery in
`apps/server/src/lib/domains/service.ts` builds a 7-day-trial-then-migrate-or-subscribe
funnel to dodge a cost that does not meaningfully exist. **Rip it out.** Every organiser gets
the same instruction regardless of DNS provider: add one CNAME. NS detection is kept only to
tailor the *instructions* (`domain-instructions.ts`, 22 providers) — never to gate access.

Do not charge organisers for domain linking.

## Standing engineering rules

- **SEO tags are injected into HTML at deploy time, never at runtime.** Sites are
  client-rendered SPAs; Google renders JS on a slower second pass and social scrapers and
  non-Google crawlers do not render at all. Covers `<title>`, description, canonical, JSON-LD.
- **Every deployed page emits a canonical** pointing at its primary URL (custom domain if
  linked, else the deploy URL). This is what stops multi-URL dilution permanently.
- **Use normalised values** (`normaliseTags` / `normaliseGeo`), never raw creator input, in
  structured data.

## Guidance we give organisers

**The user-facing copy lives in `docs/SEO_GUIDANCE.md`** — that file is the single source of
truth for what we say to organisers, including tone rules ("never use the word SEO"). #72
wires those strings in; do not re-write them somewhere else. Summary of the model:

Shipped as a live scoring panel in the builder, not a help doc.

- **Title formula:** `{what you are} in {where} | {brand}` → "Craft beer pub in Camden | The
  Lock Tavern". 50-60 chars.
- **Ambiguity test:** would a stranger type this into Google? "What's On" — no. "Live music in
  Camden this week" — yes. Same page; one is invisible.
- **One page, one intent.** A page about food *and* music *and* history ranks for nothing.
- **H1 says the same thing as the title, in human words, once per page.**
- **Names of places, not pronouns.** "right by the station" → "two minutes from Camden Town
  station". Crawlers cannot resolve "we" or "here".
- **Anchor text describes the destination** — "book our Friday live music night", never
  "click here".

Mechanically checkable: title length, missing/duplicate H1, description length, whether the
town name appears in body copy at all, link text in {"click here", "read more", "more info"}.

## Work order

| # | Item | Issue |
|---|---|---|
| 1 | Custom domain edge proxy (Cloudflare Worker) — **blocks everything below** | #67 |
| 2 | One CNAME path — drop trial/migration funnel (D6) | #68 |
| 3 | Drop sub-ENS from website builder (D3) | #69 |
| 4 | Deploy-time `<title>` + canonical injection | #70 |
| 5 | schema.org/Event JSON-LD, deploy-time injected | #55 |
| 6 | Real per-page URLs — static pre-render per page | #71 |
| 7 | SEO guidance panel in builder | #72 |
| 8 | sitemap.xml + robots.txt at deploy | #73 |

Ordering: (1) is the bottleneck for the DNS-first strategy. (5) is highest value-per-effort
and independent of (1) — it can run in parallel. (6) is the largest piece and unlocks parts
1+2 of the SEO model for multi-page sites.

## Measurement

- Organisers on their own domain can verify in Google Search Console via DNS TXT.
- ENS-hosted sites cannot use DNS-TXT verification. HTML-file verification may work since we
  control the deployed collection — **untested, do not promise it in UI until confirmed**.
