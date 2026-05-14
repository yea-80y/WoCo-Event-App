# UI Rollout — Opus Polish Handover

> Sonnet completed the mechanical rollout of the "Concrete & Acid" design language on 2026-05-14.
> This doc records exactly what was done, what was skipped, and what needs the Opus polish pass.

---

## What Sonnet did

### Cleanup sweep (pre-P1)
- Confirmed zero `--accent-hi` references anywhere in `apps/web/src` — token was already gone.
- No `logo.png` references in Svelte components other than the old `Home.svelte` (removed).
- No Bungee-on-"WOCO" misuse found in attendee/creator paths.

### P1 — Attendee surfaces (all done)

| File | Changes |
|---|---|
| `lib/attendee/home/Home.svelte` | **Full rewrite.** Stripped self-host, how-it-works, features, coming-soon, footer sections. New tight hero: kicker "Discover" + h1 "Find your scene". Clean events grid only. |
| `lib/attendee/events/EventCard.svelte` | Hover: `border-color: var(--accent)`, removed `translateY`. Date: mono kicker style. `owned-badge`: sharp `--radius-sm` mono tag. `site-badge`: mono "ext" label. |
| `lib/attendee/events/EventDetail.svelte` | `organizer-dashboard-btn`: `color: #fff` → `var(--accent-ink)`. `creator-label`: mono kicker. `.meta`: mono font for dates. |
| `lib/attendee/events/ClaimButton.svelte` | `.claim-btn` + `.stripe-btn`: `color: #fff` → `var(--accent-ink)`. `.pending-badge`: chartreuse mono tag with `.live-dot` pulse. |
| `lib/attendee/passport/MyTickets.svelte` | Kicker "Passport" above h1. `retry-btn:hover`: `color: #fff` → `var(--accent-ink)`. |
| `lib/attendee/passport/TicketCard.svelte` | Hover: `border-color: var(--accent)`, removed `translateY`. `.edition` + `.claimed-date`: `var(--font-mono)` + tabular nums. |

### P2 — Creator surfaces (partially done via /frontend-design)

| File | Changes |
|---|---|
| `lib/creator/dashboard/DashboardIndex.svelte` | Kicker on page + "External Server" section. Mono event meta. All `color: #fff` on lime → `var(--accent-ink)`. `listed-badge`: sharp mono tag. |
| `lib/creator/dashboard/Dashboard.svelte` | Kicker on heading. All `color: #fff` on lime → `var(--accent-ink)`. All `9999px` pill radii → `var(--radius-sm)`. All badge classes: mono uppercase. Hardcoded `#22c55e`, `#d97706`, `#10b981`, `#ef4444`, `#1a1a2e`, `monospace`, `var(--surface)` → proper tokens. Sales stats: mono font. |
| `lib/creator/dashboard/StripeConnect.svelte` | Status pill: `9999px` → `--radius-sm`, mono uppercase. All `#f59e0b` → `var(--warning)` (dot, borders, SVG strokes). |
| `lib/components/auth/LoginModal.svelte` | Modal radius: `--radius-lg` → `--radius-md`. Kicker "WoCo" above heading. Divider: mono uppercase micro-type. Header bottom border separator. |

### USP layout bug fix (Splitter.svelte)
- `usp--right` was using `direction: rtl` causing layout jank and text alignment issues.
- Replaced with clean `grid-column` / `grid-row` explicit placement — no direction hack.

---

## What Sonnet did NOT do (still needed)

### P2 remaining
- `lib/creator/events/EventForm.svelte` — long form; needs form primitive styles from `app.css`, sectional kicker labels, sticky CTA bar.
- `lib/creator/builder/MultiSiteBuilder.svelte` + builder tabs — heaviest surface; form patterns mirror EventForm.

### P3
- `lib/components/auth/SigningConfirmDialog.svelte` — square modal, same treatment as LoginModal.

### P4
- `lib/components/profile/ProfilePage.svelte` + `UserAvatar` — avatar ring colour check.
- `lib/creator/embed/EmbedSetup.svelte`
- `lib/attendee/passport/VerifyTicket.svelte`

### P5 — Embed widget (`packages/embed`)
- Tokens must be overridable via CSS custom properties on `<woco-tickets>`.
- Default to `var(--error)` accent but expose `--woco-accent`, `--woco-bg`.
- Don't bake fonts; inherit from host.

---

## Opus polish checklist (from the original handover doc)

These are the things Opus was always going to own — Sonnet's job was mechanical rollout, not final judgment:

- [ ] Has chartreuse leaked too far across screens? (should feel like punctuation, not wallpaper)
- [ ] Does Bungee appear anywhere it shouldn't? (`WocoWordmark` component only, never raw Bungee text for "WOCO")
- [ ] Are any radii still too soft? (target: 0/2/4/8px only)
- [ ] Hero hierarchy on Splitter — does the eye land on the right element first?
- [ ] Cross-component consistency — buttons, cards, kickers aligned everywhere?
- [ ] Any remaining white-on-lime contrast bugs? (grep: `color: #fff` near `var(--accent)` backgrounds)
- [ ] Check the `usp--right` editorial rhythm in Splitter.svelte at multiple viewport widths after the rtl → grid-column fix.
- [ ] EventForm.svelte — sticky CTA bar for long scroll, sectional kicker labels.
- [ ] MultiSiteBuilder tabs — most complex surface, needs careful judgment on form patterns.
- [ ] LoginModal — confirm WocoWordmark renders cleanly inside the compact header layout.

---

## How to check for remaining violations

```bash
# Any remaining #fff on lime
grep -rn "color: #fff" apps/web/src/lib --include="*.svelte"

# Any pill radii left
grep -rn "9999px" apps/web/src/lib --include="*.svelte"

# Any accent-hi remnants
grep -rn "accent-hi" apps/web/src

# Any hardcoded hex in styles (likely new violations)
grep -rn "color: #[0-9a-fA-F]" apps/web/src/lib --include="*.svelte"

# Type check
npx svelte-check --workspace apps/web
```

The only errors on `svelte-check` should be 2 pre-existing `esrap` node_modules errors — **zero project file errors**.
