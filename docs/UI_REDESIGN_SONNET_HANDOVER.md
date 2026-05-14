# UI Redesign — Sonnet Handover

> Opus locked the spec, built the two highest-judgment screens, and hand-authored the pixel wordmark on **2026-05-13**.
> Sonnet picks up the rollout. **Read the spec first:** `memory/project_ui_theming_direction.md`.

---

## Palette pivot (read this first)

Opus initially shipped "Concrete & Sparks" with **vermillion #FF3F1F** as primary. User flagged this as too RA.co-adjacent. Pivoted to **"Concrete & Acid"** — acid lime-chartreuse **#C7F23A** is now the single signal colour. Vermillion **#FF5B2C** is demoted to error/danger states only (`--error`).

**Critical contrast rule:** lime + white text is unreadable. Every `color: #fff` sitting on `background: var(--accent)` must become `color: var(--accent-ink)` (#0B0B09 — dark text on lime). Also: `--accent-hi` token NO LONGER EXISTS — replace any remaining references with `--accent`.

---

## What's already done (don't redo)

| Surface | File | Status |
|---|---|---|
| Design tokens | `apps/web/src/app.css` | ✅ Concrete & Acid palette (lime primary), fonts, radius, primitives |
| Pixel wordmark | `apps/web/src/lib/components/brand/WocoWordmark.svelte` | ✅ Hand-authored 5×7 pixel-grid SVG, 3 variants |
| Google Fonts | `apps/web/index.html` | ✅ Space Grotesk + JetBrains Mono + Bungee preloaded |
| Splitter `/` | `apps/web/src/lib/landing/Splitter.svelte` | ✅ Hero, 5 USP blocks, closing CTA, footer (uses WocoWordmark) |
| Creator Studio `/creator` | `apps/web/src/lib/creator/home/CreatorHome.svelte` | ✅ Hero stats, Start Something, Pick Up, Your Work, Tools, Changelog |
| Router | `apps/web/src/lib/router/router.svelte.ts` | ✅ `neutral` surface, `/` → splitter, `/discover` → events, `/creator` → CreatorHome |
| Shells | `apps/web/src/lib/layouts/{Attendee,Creator}Shell.svelte` | ✅ Lucide icons, mono nav labels, WocoWordmark in logo |
| Pixel sprites | `apps/web/src/lib/components/icons/sprites/` | ✅ TicketStub · DoorOpen · CrtMonitor · SprayCan (all chartreuse defaults) |
| `lucide-svelte` | dep added | ✅ |

The spec memory file (`memory/project_ui_theming_direction.md`) is the source of truth for palette, type, and architecture. **Don't argue with it; ask if anything seems wrong in practice.**

---

## Your rollout queue (in priority order)

### P1 — Apply the visual language to high-traffic surfaces
These screens auto-inherit the new palette (they use `var(--*)`). What needs hand-tuning: **border-radius** (drop pill/14px corners → `var(--radius-md)` or `--radius-sm`), button styles (adopt `.btn .btn--primary` / `.btn--ghost` from `app.css`), kicker labels.

1. **`apps/web/src/lib/attendee/home/Home.svelte`** — the events feed at `/discover`. The "self-host" section and the "How it works" / "Features" / "Coming soon" sections are stale and conflict with the new Splitter messaging. **Action:** strip them. Home becomes a clean events listing with a tight hero ("Find your scene") and the event grid. Anything that pitches "Create event" / "Build site" belongs on the Splitter or Creator Studio now.
2. **`apps/web/src/lib/attendee/events/EventCard.svelte`** — switch to sharp corners, hairline border, mono date kicker, lime hover (border + text), no fill.
3. **`apps/web/src/lib/attendee/events/EventDetail.svelte`** — typography pass, kicker for metadata, replace any emoji.
4. **`apps/web/src/lib/attendee/events/ClaimButton.svelte`** — primary CTA should use the new `.btn--primary` styling (lime fill + `--accent-ink` text); the "Pending Approval" badge becomes a chartreuse mono tag.
5. **`apps/web/src/lib/attendee/passport/MyTickets.svelte`** — wrap ticket previews in the new card primitive; ticket numbers in JetBrains Mono.

### P2 — Creator surfaces

6. **`apps/web/src/lib/creator/dashboard/DashboardIndex.svelte`** — currently the "My Events" list. Restyle rows as compact cards with mono metadata; keep the Stripe section but apply card primitive.
7. **`apps/web/src/lib/creator/dashboard/Dashboard.svelte`** — single-event admin. Tabs/sub-nav need mono kickers; numbers in mono.
8. **`apps/web/src/lib/creator/events/EventForm.svelte`** — long form; apply form primitive styles from `app.css`, sectional kicker labels, sticky CTA bar.
9. **`apps/web/src/lib/creator/builder/MultiSiteBuilder.svelte`** + tabs — heaviest surface, defer last. Form patterns mirror EventForm.
10. **`apps/web/src/lib/creator/dashboard/StripeConnect.svelte`** + `StripeConnectModal.svelte` — adopt card + button primitives.

### P3 — Auth + global modals

11. **`apps/web/src/lib/components/auth/LoginModal.svelte`** — square modal, hairline border, Bungee for the "WOCO" header if used, vermillion CTAs.
12. **`apps/web/src/lib/components/auth/SigningConfirmDialog.svelte`** — same treatment.

### P4 — Profile, embed, verify (lower priority)

13. `apps/web/src/lib/components/profile/ProfilePage.svelte` + `UserAvatar` ring color → vermillion
14. `apps/web/src/lib/creator/embed/EmbedSetup.svelte`
15. `apps/web/src/lib/attendee/passport/VerifyTicket.svelte`

### P5 — Embed widget bundle (`packages/embed`)

Inherit the same tokens but the embed runs **outside** WoCo's app shell, on third-party sites — accent colors should be **overridable via CSS custom properties** that organisers can set on `<woco-tickets>` element. Default to vermillion but expose `--woco-accent`, `--woco-bg`. Don't bake fonts; inherit from host.

---

## House rules (do not violate)

- **`var(--token)` only** — no hardcoded hex. Use the new tokens in `app.css`. New tokens added there if genuinely needed.
- **`var(--accent)` (lime) is the brand colour** — used sparingly. LIVE dots, success states, surface badges, stat-num "hot" state, kicker bullet dots, primary CTAs. Never on body text, never on >10% of a screen.
- **Dark text on lime always** — every `var(--accent)` background pairs with `var(--accent-ink)` foreground. White on lime is unreadable.
- **`var(--accent-hi)` no longer exists** — any leftover references must become `var(--accent)`.
- **Vermillion `var(--error)` is reserved** for error/danger/destructive states ONLY. Never use as accent decoration.
- **`var(--font-tag)` (Bungee) used SPARINGLY** — rare graffiti accents. The wordmark is the pixel WocoWordmark component, NOT Bungee.
- **Use `WocoWordmark` for the wordmark** — never type `WOCO` in Bungee. Import from `lib/components/brand/WocoWordmark.svelte`. Props: `height` (number), `variant` (`"default" | "solid" | "ink"`), optional `onclick`, `title`.
- **No emojis in UI surfaces** — replace with Lucide icons or pixel sprites.
- **Radius scale is `0/2/4/8`** — anything with `border-radius: 14px` / `9999px` / `50%` (except avatars) needs to drop.
- **No drop shadows** — hairline borders are the rhythm. The only exception is the accent CTA's `box-shadow: 0 0 0 1px var(--accent)` outline.
- **Mobile-first** — every component must work at 320px width.
- **CSS lives next to its Svelte markup** (`<style>` block in the same file) — per CLAUDE.md.

---

## Component primitives now in `app.css`

```
.btn            base button shell
.btn--primary   lime fill (var(--accent)), dark text (var(--accent-ink)), square corners
.btn--ghost     hairline border, transparent fill, lime hover
.btn--lg        bigger padding for hero CTAs

.card           hairline-bordered surface
.kicker         UPPERCASE mono with chartreuse dot prefix
.kicker--plain  same, no dot
.tag-display    Bungee text — RARE graffiti accents only (NOT wordmark — use WocoWordmark)
.mono           JetBrains Mono with tabular numerals
.live-dot       pulsing chartreuse dot
.scanlines      0.025 opacity scanline overlay (hero only)
.grain          0.05 opacity SVG noise (hero only)
```

Use these instead of redefining. If you need something new, add it to `app.css` so other components can share.

---

## Pixel sprite usage

Already-built sprites (`apps/web/src/lib/components/icons/sprites/`):

- `TicketStub.svelte` — organiser CTAs, Create event tile
- `DoorOpen.svelte` — attendee CTAs ("I'm here for a show")
- `CrtMonitor.svelte` — "Build a venue site" tile
- `SprayCan.svelte` — graffiti accent, closing CTA

Each takes `size` (number) and `color` (string, default `currentColor`). They're SVG with explicit rects + `shape-rendering: crispEdges` — they stay crisp at any pixel-multiple size. **Add more sprites** if you need them for empty states or features; keep them on a 16×16 grid.

Bigger feature icons (Shield, Layers, etc.) come from `lucide-svelte`. Use `strokeWidth={2.25}` consistently — Lucide default 2 reads thin against the chunky type.

---

## Cleanup sweep before priority work

Before starting P1, do a quick mechanical sweep to clear palette-v1 debris:

1. **Find `--accent-hi` and replace with `--accent`** (token removed).
   ```
   rg --files-with-matches '\-\-accent-hi' apps/web/src
   ```
2. **Find `color: #fff` on lime backgrounds** and swap to `var(--accent-ink)`. The pattern to look for is a CSS block where `background:` (or `background-color:`) contains `var(--accent)` AND `color:` is `#fff` or `white`. Many `#fff` uses elsewhere (text on dark cards) are fine.
3. **Find any remaining `<span class="tag-display">WOCO</span>` or `font-family: var(--font-tag)` applied to "WOCO" text** — replace with `<WocoWordmark />`.
4. **Find `public/logo.png` imports/refs in Svelte components** — replace with WocoWordmark. (Favicons in `index.html` can stay for now.)

These sweeps probably catch 80% of the rollout drudgery in a single pass.

---

## Final pass

When Sonnet finishes the rollout, **hand back to Opus for a polish pass**. Things Opus will check:

- Has chartreuse leaked too far across screens? (it should feel like a punctuation mark, not a colour)
- Does Bungee appear in places it shouldn't? (Wordmark must be WocoWordmark, not Bungee text.)
- Are any radii still too soft?
- Hero hierarchies — does the eye land on the right thing?
- Cross-component consistency — buttons, cards, kickers all aligned?
- White-on-lime contrast bugs caught and fixed?

---

## Open questions for the user (flag these, don't decide alone)

- **Logo file** — `public/logo.png` is the old raster logo. The new design uses the hand-authored pixel `WocoWordmark.svelte` component for all in-app chrome. Old logo still appears in some places (favicons, OG images, generated-site templates, email assets). Should we generate a PNG export of the pixel wordmark for those raster contexts, or leave logo.png in place for non-app uses?
- **Custom domain landing** — when WoCo is hosted on its own domain (woco.eth.limo), the Splitter is the marketing site. Should we add a `?from=` query to track which CTA gets clicked more, so we can A/B copy later?
- **Attendee discovery polish** — `/discover` still has the old "Coming soon" / "Features" sections in Home.svelte. P1 task #1 in this doc says strip them; confirm before Sonnet removes copy.
