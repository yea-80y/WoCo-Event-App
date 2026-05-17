# Ship 2026-05-17 — Tracker

Live build checklist. Spec: `docs/SHIP_2026-05-17_SPEC.md`. Update after every commit.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked

---

## P2 — Attendee Lockdown

- [x] **Open question resolved:** bottom-nav label stays `Tickets` (confirmed 2026-05-17).
- [x] Add `/soon/:feature` route in `router.svelte.ts`
- [x] `SoonPill.svelte` (shared 15-line component)
- [x] `ComingSoon.svelte` (run `/frontend-design`)
- [x] `AttendeeShell.svelte`: wrap nav icons with `SoonPill`, redirect handlers to `/soon/...`
- [x] `AttendeeShell.svelte`: de-emphasise `.sign-in-btn` styling
- [x] `Splitter.svelte`: redirect "My tickets" links to `/soon/tickets` (line 32 + 213)
- [x] `LoginModal` + `loginRequest`: optional `context: "attendee" | "creator"` for subtitle
- [x] Add `/soon` route render in `AttendeeApp.svelte`
- [x] Build check: `npm run build:web` passes
- [ ] Manual click-through: `/discover`, `Tickets`, `Profile`, Sign in (both surfaces)
- [ ] Commit

## P3 — Creator Simplify

- [x] `VITE_ENABLE_INAPP_CREATOR` flag + redirect in `CreatorApp.svelte`
- [x] `SiteBuilder.svelte`: rip Step 1 (env template) markup + state
- [x] `SiteBuilder.svelte`: rip Step 2 (API verify) markup + state, hardcode `apiUrl` from env
- [x] Renumber wizard to 1–3
- [x] `GatewayPicker.svelte` + `GATEWAYS` registry (WoCo only, Etherna commented out)
- [x] `AdvancedSetup.svelte` wrapping removed UI
- [x] `?advanced=1` query param recognised in `router.svelte.ts`
- [x] Build check: `npm run build:web` + `npm run build:server`
- [ ] Manual click-through: fresh event creation end-to-end (Stripe + ETH + email-only)
- [ ] Commit

## P4 — Feed-only event-to-site

- [x] `addSiteEvent()` in `apps/web/src/lib/api/sites.ts`
- [x] `SiteSelector.svelte` (multi-checkbox over `getCreatorSites()`)
- [x] Wire into SiteBuilder Step 2 + post-publish `Promise.allSettled` call
- [x] `SiteEventsManager.svelte` (post-deploy management screen)
- [x] New route `/creator/sites/:siteId/events`
- [x] `EventsGridSection.svelte`: default to date-ascending sort; honour `sortMode: "manual"`
- [x] `packages/shared/src/site/types.ts`: add `sortMode?: "date" \| "manual"` to `EventsGridSection`
- [x] Build check: both build commands pass
- [ ] Manual: create event with two sites ticked → both deployed sites show it within 5min, no redeploy
- [ ] Commit

---

## Deploy

- [x] Frontend deploy via `npm run deploy` (feed index 64)
- [x] Server deploy via rsync sequence (PIDs 17032/17033 healthy)
- [ ] Smoke test on live: Splitter → Discover → event purchase via Stripe → email arrives

## Notes / blockers

(empty — append as encountered)
