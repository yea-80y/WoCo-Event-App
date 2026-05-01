# Multi-Page Site Builder — Plan

Status: **proposal** (2026-05-01). Supersedes the single-event builder for venues that
need a full website (Black Prince pub is the first concrete client).

Goal: let an organiser build a multi-page website from templates, then funnel them
into creating events that deploy *into* that website. The first venue template (pub)
becomes a reusable preset; new templates plug into the same schema.

## 1. Scope

### In scope (v1)
- Site = collection of pages + theme + nav + brand, published to Swarm as a single
  dist with a tiny client-side router.
- Builder UI inside `apps/web` (lazy-loaded route, **not** a separate app yet) that
  lets the organiser pick a template, edit per-page sections, preview, publish.
- Multi-event support: a `SiteEventsIndex` feed the deployed site reads at runtime
  so adding/removing events does **not** require rebuilding the site.
- One template at launch: **Pub/Venue v1** (Black Prince).

### Out of scope (v1)
- True drag-and-drop reordering (use ↑/↓/✕/➕ buttons; revisit if real users hit
  friction).
- Multi-tenant CMS-style editing post-deploy from the live site (organisers re-run
  the builder + re-publish for content edits — Swarm-native; cheap because of
  feed-manifest indirection).
- Splitting builder into its own app (`apps/creator`). Stays a lazy chunk in
  `apps/web` until bundle size justifies the split.

## 2. Data model — `packages/shared/src/site/`

```ts
type ThemeTokens = {
  brandName: string;
  logoSwarmRef?: Hex64;          // uploaded to Swarm; site fetches at runtime
  palette: { bg; text; muted; accent; accentHover; border; cardBg };
  fontFamily?: "system" | "serif" | "display"; // pick from allowlist
  radius?: "sm" | "md" | "lg";
};

type NavItem = { label: string; pageSlug: string };

type Site = {
  siteId: string;                // ulid
  templateId: "pub-venue-v1";    // future: more templates
  schemaVersion: 1;
  theme: ThemeTokens;
  nav: NavItem[];                // ordered
  pages: Page[];                 // first one with slug "/" is home
  contact: { email?; phone?; address?; lat?; lng?; mapUrl? };
  socials: { twitter?; instagram?; facebook? };
  eventsIndexFeed: string;       // topic of SiteEventsIndex feed
  createdAt: number;
  updatedAt: number;
};

type Page = {
  slug: string;                  // "/", "/whats-on", "/visit", "/contact"
  title: string;                 // <title> + nav label fallback
  sections: Section[];
};

type Section =
  | { id; type: "hero"; heading; subheading?; ctaLabel?; ctaHref?; bgImageRef?: Hex64 }
  | { id; type: "richText"; markdown: string }
  | { id; type: "gallery"; images: { ref: Hex64; alt: string }[] }
  | { id; type: "eventsGrid"; mode: "upcoming" | "all" | "featured"; max?: number }
  | { id; type: "featuredEvent"; eventId: string }
  | { id; type: "openingHours"; rows: { day: string; hours: string }[] }
  | { id; type: "map"; lat: number; lng: number; zoom?: number; label?: string }
  | { id; type: "contactForm"; emailTo: string }   // posts to API; rate-limited
  | { id; type: "embed"; html: string };           // sanitized; Instagram/iframe fallbacks
```

**Why JSON config + render-time components:** the builder is just a form over this
schema; the deployed site is a normal Vite build of the same Svelte components reading
the JSON from `window.SITE_CONFIG`. No code generation, no template engine, no per-site
fork. Adding a new template is adding a `templateId` preset (defaults for theme/pages).

## 3. Multi-event runtime

Today: `SiteApp.svelte` reads a single `EVENT_ID` baked at build time.
Tomorrow:
- `eventsGrid` section reads `SiteEventsIndex` feed (`woco/site/{siteId}/events`) on
  mount → renders cards.
- `featuredEvent` section is the same component as today's `EventPage.svelte`.
- Routing: `#/` home, `#/events/:id` event detail, `#/dashboard` (auth-gated, same as
  today). Hash-based to keep Swarm-friendly (no server rewrite rules).

**Adding a new event after publish** = organiser opens builder → "Events" tab →
creates event (existing `EventEditor.svelte` flow) → builder appends `eventId` to
`SiteEventsIndex` feed. **No site rebuild.** This is the killer feature vs. static-site
generators — Swarm feed indirection means content updates are free.

## 4. Builder UI

Single Svelte route `/build` (lazy-loaded chunk). Tabs across the top:

1. **Template** — pick from gallery (one option at launch). Sets `templateId` + seeds
   default pages, theme, nav.
2. **Brand** — logo upload, palette picker (preset palettes + advanced custom),
   font family.
3. **Pages** — list of pages on the left, sections editor on the right. Each section
   is a card with type-specific inputs + ↑/↓/duplicate/delete buttons. "+ Add section"
   opens a typed picker (hero, gallery, eventsGrid, …).
4. **Navigation** — reorder `nav` items, set labels, link to pages.
5. **Events** — list of events in this site, with "Create event" CTA that opens the
   existing `EventEditor` + `PublishButton` flow, then auto-appends to
   `SiteEventsIndex`. Edit/unlist controls.
6. **Preview** — full-screen iframe that loads the site bundle with a draft
   `SITE_CONFIG` injected via postMessage (no upload until publish).
7. **Publish** — same domain registration + Swarm deploy pipeline as today's
   `SiteBuilder.svelte` step 5. Diffs vs current: deploys the multi-page bundle and
   writes `Site` JSON to a `SiteConfig` feed, not just an event ref.

Editor primitives (~all already present in the repo): text/textarea, image upload
(hits existing Swarm upload endpoint), color picker (new — small, ~3KB), markdown
editor (use `marked` + textarea; no WYSIWYG dep).

## 5. Server changes

Mostly additive — current event endpoints are unchanged.

- `POST /api/sites` — create site, returns `siteId` + feed topics.
- `PATCH /api/sites/:id` — update site config (writes `SiteConfig` feed).
- `POST /api/sites/:id/events` — append event to `SiteEventsIndex` feed.
- `DELETE /api/sites/:id/events/:eventId` — remove from index (event itself stays,
  just unlinked from this site).
- `POST /api/sites/:id/deploy` — build + upload site bundle, register domain (reuse
  existing pipeline from `SiteBuilder.svelte`).
- `POST /api/sites/:id/contact` — handle contactForm submissions (rate-limited per
  IP, sends email via existing email pipeline).

New feed topics:
```
woco/site/config/{siteId}        # Site JSON
woco/site/{siteId}/events        # ordered list of eventIds
```

## 6. Deployed site (Vite output)

A second Vite entry at `apps/web/src/SiteApp.svelte` is the runtime. Build script
inlines a `SITE_CONFIG` placeholder that the deploy step replaces with the actual JSON
(or fetches it from feed at boot — TBD; both work, fetch-from-feed enables zero-rebuild
content edits but adds a request before first paint).

Recommended: **inline at deploy + also expose feed reference** so simple content
tweaks (typo fix, hours change) can either re-deploy the bundle (fast on Swarm) or
just update the feed (instant; site re-fetches on next load).

## 7. Bundle/perf considerations

- Builder chunk lazy-loaded — zero impact on attendee-facing event page bundle.
- Map section uses static map image (no Mapbox SDK) — `staticmaps` style URL or our
  own tile snapshot. Keeps deployed site < 100KB.
- Image gallery uses `<img loading="lazy">` + Swarm refs.
- Markdown rendered at build, not runtime, where possible (richText sections).

## 8. Phased delivery

| Phase | Scope | Est. effort | Ships |
|-------|-------|-------------|-------|
| 0 | Schema + types in `packages/shared`, server endpoints stubbed | 1d | nothing user-visible |
| 1 | Pub/Venue template preset + site renderer (read-only from hand-written JSON) | 2d | a deploy of Black Prince by hand-editing JSON; proves the runtime |
| 2 | Builder UI: Brand + Pages tabs (no events yet) | 3d | organiser can build a non-event site |
| 3 | Multi-event: events tab + `SiteEventsIndex` + `eventsGrid` section | 2d | full "site with events" flow |
| 4 | Preview pane, contact form, polish | 2d | v1 launchable |
| 5 | Black Prince content port + theming | 1–2d | live site |

**Total: ~2–2.5 weeks for one engineer** to a launchable v1 with Black Prince live.

Phase 1 is the critical de-risk — once the renderer reads JSON and produces a
working site, everything else is form-building over the same schema.

## 9. Future templates

Adding a second template after v1:
- New `templateId: "restaurant-v1"` preset (different default pages, theme, maybe a
  new section type like `menu`).
- New section types are additive to the discriminated union — old sites keep working.
- Template gallery in step 1 of builder shows screenshots; user picks one.

## 10. DnD upgrade path (deferred)

If/when DnD is needed: drop in `svelte-dnd-action` (~10KB), wrap the section list in
a sortable container, persist on drop. Existing schema needs no changes. Plan for
~3–5 days including mobile testing. **Don't build until users ask.**

## 11. WASM relevance

None for v1. WASM is worth considering only if we later add:
- In-browser image cropping/compression at scale (squoosh-wasm).
- Client-side video transcoding for hero clips.
- zk proofs for ticket auth.

The site builder is forms + JSON + Svelte rendering — no compute-bound work.
WASM does **not** replace the server; webhooks (Stripe) and email sending still need
a public HTTP endpoint, even if it's a Cloudflare Worker.

## 12. Open questions

- **Contact form email**: send via existing server email pipeline, or proxy through
  organiser's own SMTP? v1 = ours; future = optional own-SMTP.
- **Site listing on woco.eth.limo**: do these multi-page sites get listed in the
  WoCo discovery feed, or are they purely standalone? Lean: optional opt-in, same
  as today's single-event site listing.
- **Edit-after-publish UX**: builder loads existing `Site` config from feed and
  re-uses the same form? Yes — should be transparent ("Edit your site" vs "Build new").
- **Domain UX**: same as today's `SiteBuilder.svelte` (DNS verification + ENS
  optional). No changes required.

## 13. Acceptance criteria

- An organiser can sign in, pick the Pub template, fill brand + 3 pages + 2 events,
  preview, and publish to a Swarm gateway URL — without writing any code.
- Adding a 3rd event after publish takes <60s and does not require a rebuild.
- The deployed site is < 200KB gzipped (excluding images).
- Black Prince's existing content (events list, hours, location, contact) is fully
  representable in this schema.
