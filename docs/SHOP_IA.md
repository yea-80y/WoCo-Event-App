# WoCo Shop — Information Architecture & Positioning

Status: PROPOSAL for sign-off (2026-06-02). Design language: **Concrete & Acid**
(acid lime `#C7F23A`, 1px hairlines, `--font-mono` for amounts, dense layouts,
`var(--token)` only). Companion to `docs/WOCO_SHOP_PLAN.md` (the money model) and
`docs/SHOP_OPUS_HANDOVER.md` (build state).

## The problem

A Shop today can only be born inside the **website builder** (`MultiSiteBuilder
→ ShopTab`). Catalog editing lives there; POS lives at `/creator/shops/:id/pos`;
`MyShopsScreen` lists shops but nothing in the primary nav reaches it. So a
merchant who wants *just a POS* (bar, market stall) or *just a shop link* (no
full website) is forced to build a website first. Wrong — the website is one
*surface*, not the shop's home.

## Mental model to lock: ONE CATALOG → MANY SURFACES

A **Shop** = a catalog (products + categories) + payment config. It is created
and managed in its own studio, then *projected* onto any combination of:

| Surface | Who operates | Where it lives | Status |
|---------|-------------|----------------|--------|
| **POS** | staff at a counter | `/creator/shops/:id/pos` | live |
| **Standalone storefront** | customer self-serve | a hosted Swarm URL (auto single-page site) | NEW |
| **Website section** | customer self-serve | `productGrid` section in a full multi-page site | live |
| **Tap-to-pay** | attendee authorises, staff POS pulls | festival gate QR → `/shops/:id/tap` | rail live; entry building |
| **Embed** | customer on a 3rd-party site | `<woco-shop>` web component | later |

The merchant never asks "do I open the shop area or the website builder?" — they
open **Shop**, manage the catalog once, and turn surfaces on.

## Creator-side IA

### Navigation (minimal-disruption recommendation)
Keep the 5-slot bottom nav uncluttered. Make Shop first-class via two moves:

1. **Studio hub (`/creator`)** gains a **Shops** panel + stat, alongside the
   existing Events and Sites panels. (Today it shows only Events + Sites.)
2. The centre **`+` Create** becomes an **action sheet**: *New event · New shop ·
   New site*. One global "make something" affordance that scales.

(Alternative if Shop should be more prominent: give it a dedicated bottom-nav
slot — Studio · Events · Shops · Sites · Profile, Create demoted to the action
sheet. More prominent, but 5 tabs is the mobile ceiling.)

### Shop studio
- **`/creator/shops`** — shop list (`MyShopsScreen`, exists). Each card shows
  surface status: *POS ready · Storefront live at <url> · in N websites · tap-to-pay on*.
  "New shop" CTA. Reachable from Studio hub + the Create action sheet.
- **`/creator/shops/:id`** — **Shop editor (NEW)**, the home for one shop:
  - **Catalog** — products + categories CRUD (the logic currently in `ShopTab`,
    promoted here as the canonical editor).
  - **Payments** — rails (card / USDC), recipient, fees, tap-to-pay defaults
    (cap, window).
  - **Surfaces** — the deploy hub (see below).
  - **Orders** — order log (pickup codes, paid/pending).
  - **Loyalty** — POD reward rules (step 4, later).
- **`/creator/shops/:id/pos`** — POS (live).

### Surfaces tab = the seamless "what do I want to do"
- **POS** → Open POS · share a staff/device link (the on-site terminal login).
- **Storefront** → *Deploy as a standalone page* → hosted URL + QR. Or *Add to an
  existing website* (links into the site builder's `productGrid`).
- **Tap-to-pay** → printable **festival gate QR** to `/shops/:id/tap` + cap/window.
- **Embed** → (later).

### Standalone storefront = auto single-page site (the simplification)
"Deploy a standalone shop page" is implemented as: generate a **one-page Site**
(hero + `productGrid` for this shop) via a new `newSiteFromShop()` template and
deploy it through the **existing site publish/deploy pipeline**. No new backend.
The merchant gets a URL + QR without ever opening the builder; *"Expand into a
full website"* later just opens the builder on that same site. The website
builder's `ShopTab` is demoted to *"this site shows a shop → pick/quick-create
one"*, not the sole catalog editor.

## Attendee-side IA

- **Standalone storefront / website section** — shopping + checkout (card / online
  USDC). Done this session (item #1).
- **`/shops/:id/tap`** — tap-to-pay activation. Festival gate QR → main app →
  passkey login if needed → `SpendGrantModal` ("Authorise £50 for this event").
  *One* approval; staff POS then pulls each round, gasless, within the cap.
- **Profile → Tap-to-pay** — the **spending-wallet view**: each active permission's
  cap / spent / remaining + Revoke. This is the "account they treat like a
  spending wallet" — but non-custodial: the USDC never leaves the attendee's own
  Kernel wallet; the grant is a capped, revocable *authorisation*, not a deposit.

## Funding vs authorising (regulatory note)
Two independent axes, often conflated:
- **Authorising spend** = the spend-permission grant (the £50 cap). Non-custodial.
- **Funding the wallet** = how USDC gets into the attendee's Kernel wallet: crypto
  users already hold it; fiat users top up via the (later, mainnet) fiat on-ramp.
  Custodial preloaded balances stay OUT (e-money / money-transmission regulation).

Wristbands are a **later hardware auth-carrier** over this exact model ("scan band
→ identify wallet → authorise/spend"), not a new money model.

## Build order (proposed)
1. **Tap-to-pay surfaces** (approved): `/shops/:id/tap` route + screen, and the
   Profile spending-wallet view. Independent of the studio refactor — ship first.
2. **Shop studio**: Shop editor (`/creator/shops/:id`) with Catalog/Payments/
   Surfaces/Orders; promote catalog editing out of `ShopTab`; Studio-hub Shops
   panel + Create action sheet.
3. **Standalone storefront**: `newSiteFromShop()` + Surfaces "Deploy storefront".
4. **Loyalty** (step 4) when reached.
