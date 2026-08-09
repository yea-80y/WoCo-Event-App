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

## Verified current state

> **Re-audited 2026-07-27 against the code and the live web.** Two claims in the original
> 2026-07-26 list were wrong and are corrected inline below (marked ⚠️). Everything else
> was re-checked and holds. Line numbers drift — treat them as hints, not addresses.

- Deployed sites ship `<title>Site</title>` — `apps/web/multi-site.html:6` (verified 2026-07-27). Deploy-time
  injection (`apps/server/src/routes/sites.ts:715-737`) writes `og:*`, `twitter:*` and
  `meta description` but **never `<title>`**. Real title is set only by JS at runtime
  (`MultiSiteApp.svelte`, `document.title = site.theme.brandName`).
- **Hash routing** — `#/about`, `#/contact` (`MultiSiteApp.svelte` `parseHash()`). Crawlers discard
  the fragment, so an N-page site is ONE indexable URL. Parts 1+2 above have nowhere to land.
- `Page.metaDescription` is defined (`packages/shared/src/site/types.ts:254`) and read at
  runtime (`MultiSiteApp.svelte:219`) but **has no editor field anywhere in the builder**.
- H1s are accidental: `HeroSection.svelte:25` emits one, and (⚠️ omitted originally)
  `components/site/EventPage.svelte:618` emits `<h1 class="event-title">`. A page without a hero has no
  H1; `RichTextSection.svelte:14` turns a user's `# ` into a second H1. No warnings.
- ⚠️ **CORRECTED 2026-07-27.** The original claim "no canonical, no JSON-LD anywhere" was
  **false**. `apps/web/src/lib/seo/head.ts` (93 lines) implements `setJsonLd`,
  `setCanonical`, `setMetaDescription` and `setTitle`, and is already used by
  `attendee/events/EventDetail.svelte`, `components/site/EventPage.svelte`,
  `EventsGridSection.svelte` and `FeaturedEventSection.svelte`.
  **The gap is placement, not existence:** it all runs client-side at runtime, which the
  standing rule below says is insufficient — non-rendering crawlers and social scrapers
  never execute it. #70/#55 are therefore *move it to deploy-time injection*, *not* build
  it from scratch. Still genuinely absent: **robots.txt** and **sitemap.xml**.
- The bzz contentHash **changes on every republish** → the URL changes → indexing resets.
  A stable hostname in front is a precondition for any SEO at all.
- `packages/edge-proxy/` **does not exist**. `docs/CUSTOM_DOMAINS_PLAN.md` describes it; it
  was never built. Server half IS built: registry, `GET /api/domains/resolve/:hostname`
  (public), CNAME verification poller, `DomainLinker` UI, contentHash auto-update on deploy.
- eth.limo IS crawlable, and ⚠️ **more permissive than originally recorded.** The claim that
  `robots.txt` "disallows only `/wiki/` paths" was **false**. Fetched 2026-07-27,
  `https://eth.limo/robots.txt` is in full:

  ```
  User-agent: *
  Allow: /

  Sitemap: https://eth.limo/sitemap.xml
  ```

  Fully open, with a sitemap. `woco.eth.limo` returns `HTTP/2 200`, `content-type:
  text/html`, no `x-robots-tag` header (so no `noindex`), `cache-control: max-age=300`.
  **ENS hosting is not an indexing dead end** — that conclusion stands and is now on firmer
  evidence than when it was written.

## Decisions

### D1 — Address ladder

| Tier | Status |
|---|---|
| Organiser's own DNS domain | **Recommended path.** Only tier where authority accrues to them. |
| Organiser's own ENS name | Supported. Their asset, their choice. |
| WoCo-issued sub-ENS (`{label}.woco.eth`) | **Returning to the website builder** (owner, 2026-08-09) — Shopify-parity default address. Ships WITH canonical injection (#70), not before. See D3. Already live on profiles and event pages. |
| WoCo-issued free subdomain on `woco-net.com` | **Rejected, and still rejected** — see D2. Not the same question as the row above: `woco-net.com` is the registrable domain that also carries `events-api.` and `gateway.`. |

### D2 — No WoCo-issued free subdomain tier

Rejected 2026-07-26. Reasons, strongest first:

1. Free subdomains on `woco-net.com` put anonymous hosting behind the **same registrable
   domain as `events-api.` and `gateway.`**. Safe Browsing / spam reputation acts at that
   level — one phishing site would poison our API and gateway.
2. Strictly worse SEO than the thing it substitutes for.
3. Adds wildcard certs, a namespace with squatting rules, and a takedown process.
4. Organisers serious enough to do SEO have a domain already.

### D3 — Sub-ENS dropped from the website builder entirely

> ## 🔄 REOPENED 2026-08-09 by the owner — do NOT action the removal below
>
> **Sub-ENS is coming BACK to the website builder.** Nothing in D3 may be used to justify
> deleting `Site.subEnsLabel`, `<SubENSPicker>`, or the deploy contenthash hook. Issue #69
> is reopened-in-place and its "Scope" section is now the wrong instruction.
>
> **Why the reversal.** Every store on Shopify gets a `{store}.myshopify.com` address the
> moment it signs up, and WoCo should match that. Verified against Shopify's own docs
> rather than assumed — and the framing differs from "a demo URL" in a way that matters:
>
> - It is assigned by default at signup and is a **permanent identifier** — it cannot be
>   removed or transferred, and it is what their admin login, support and app integrations
>   key off.
> - It **is** the working storefront address until a custom domain is set as primary.
> - Once a custom domain is primary, the `myshopify.com` address **redirects** to it and is
>   not shown to customers.
>
> So it is not framed as a preview or demo tier. It is a permanent system address that
> doubles as the shareable storefront until the organiser attaches their own domain — which
> is exactly the gap D3 left open (see the "accepted consequence" below: an organiser with
> no DNS domain and no ENS name currently has no shareable address at all).
>
> **D2 is NOT reopened, and the two are different questions.** D2 rejects a WoCo-issued
> subdomain on `woco-net.com`, and its strongest reason still stands untouched: that puts
> anonymous hosting behind the **same registrable domain as `events-api.` and `gateway.`**,
> where Safe Browsing and spam reputation act. Sub-ENS is on `woco.eth` / `eth.limo` — a
> different registrable domain — so it does not inherit that objection. Do not merge the two.
>
> **The condition attached to bringing it back.** D3's load-bearing reason was never the
> authority argument (retracted below as unproven) — it was **one page reachable at four
> URLs with no canonical to disambiguate**, and that objection is still valid. It is fixed
> the way Shopify fixes it: one canonical address, everything else pointing at it.
>
> Note the mechanism differs. Shopify issues an HTTP redirect; WoCo cannot, because
> sub-ENS resolves via contenthash through eth.limo and there is no origin of ours in that
> path to return a 301 from. The achievable equivalent is a deploy-time
> `<link rel="canonical">` naming the organiser's primary domain — which is already planned
> as **item 4 / #70**. Therefore: **sub-ENS returns to the website builder together with
> canonical injection, not before it.** Shipping it without #70 rebuilds the exact duplicate-
> URL problem D3 correctly identified.
>
> This does not conflict with "the custom-domain worker must proxy, never redirect" — that
> rule is about serving the canonical domain itself. Pointing the non-canonical addresses at
> it is the same policy seen from the other end.
>
> Sources: [Shopify — Adding a domain](https://help.shopify.com/en/manual/domains/add-a-domain) ·
> [Shopify — Change your primary domain](https://help.shopify.com/en/manual/domains/domain-type/change-primary-domain) ·
> [Shopify — Managing domain settings](https://help.shopify.com/en/manual/domains/managing-domains)

WoCo-issued sub-ENS (`{label}.woco.eth`) was **removed from the multi-page site builder**.
⚠️ Superseded by the reversal above — retained for the reasoning, not as an instruction.

⚠️ **Rationale corrected 2026-07-27 — the decision stands, one of its two reasons does not.**

- **"It built authority on `eth.limo`, a third-party shared root we don't control"** —
  **UNPROVEN, and so is its opposite. Do not treat either as fact.**

  Checked 2026-07-27 against Google's primary documentation: the URL-structure page
  ([developers.google.com/search/docs/crawling-indexing/url-structure](https://developers.google.com/search/docs/crawling-indexing/url-structure))
  **says nothing about subdomains vs subdirectories.** There is no Google-documented
  support for the original claim, *nor* for the "subdomains build authority independently"
  rebuttal — both are SEO-industry folklore, and the industry contradicts itself on it.
  Note also that "Domain Authority" is a **Moz** metric; Google has publicly denied using
  such a signal, which makes the whole frame unreliable.

  **What is actually evidenced:**
  - eth.limo subdomains *do* get indexed — `ensinterviews.eth.limo` surfaced unprompted in
    two independent searches, and Similarweb publishes traffic analytics for
    `liber3.eth.limo`. Evidence of indexing; **not** evidence of ranking well.
  - eth.limo reports 2.5–3M req/day across tens of thousands of dWebsites at 99.999%
    uptime (their claim, not independently verified) — which weakens "uptime dependency"
    as an argument.
  - The one durable residue: Safe Browsing and spam reputation **do** act at the
    registrable-domain level, unlike ranking. That is a real, narrow risk.

  **If this question ever becomes load-bearing, settle it with data, not argument:** put a
  page on each surface, verify both in Search Console, and compare impressions. Anything
  else is speculation dressed as a rationale.
- **"Multiplied one page across four URLs with no canonical to disambiguate"** — **holds,
  and is the load-bearing reason.** Duplicate-URL dilution is the actual problem, and it is
  fixed by canonicals, not by removing an address tier.

**Do not cite the authority argument to justify moving WoCo's own canonical off
`woco.eth.limo`.** That is a positioning decision, not one this document has evidence for.
The measured argument for a conventional domain is the **~3.3s TTFB floor** in
`PERF_BASELINE_ETH_LIMO.md` (Core Web Vitals), not domain authority.

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

**Cloudflare for SaaS pricing — re-verified 2026-07-27** against Cloudflare's own docs
(100 included, $0.10/hostname beyond, 50,000 ceiling, standard certs included; all confirmed): 100 custom hostnames included free on
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
| 3 | ~~Drop sub-ENS from website builder (D3)~~ → **REVERSED 2026-08-09.** Keep sub-ENS; bring the picker back as the Shopify-parity default address. Sequenced AFTER item 4 (#70), because canonical injection is the condition | #69 (reopened in place) |
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
