# WoCo Shop — Step 3 UI handover (Opus → Sonnet)

Step 2 (all payment rails) is DONE. Step 3 = build the customer web shop + staff POS
skin. **Opus has locked the visual language and built the two hero surfaces**
(`ProductCard` + `ShopPos`); Sonnet builds the rest against this spec. Anything
touching signatures/funds/spend-permission logic goes BACK to Opus — the UI here only
*calls* the APIs from `api/shop-payment.ts` + `api/shop-spend-permission.ts`.

## Non-negotiables (read first)
- **Design language = Concrete & Acid.** Tokens in `apps/web/src/app.css`; see
  `project_ui_theming_direction` memory. NEVER hardcode hex — `var(--token)` only.
- **No "Claude default" look** (`feedback_avoid_claude_default_look`): hairline 1px borders,
  sharp radii (`--radius-sm/md`, max `--radius-lg`), dense layouts, mono for numerics/codes,
  NO big drop-shadows, NO `rounded-2xl`, NO generic emoji. Use Lucide at `strokeWidth={2.25}`
  or inline SVG; the project's pixel sprites for graffiti accents only.
- **Acid lime `--accent` is the single signal colour.** Text on lime is ALWAYS `--accent-ink`
  (dark) — never white. Vermillion `--error` only for sold-out / failure / destructive.
- Svelte 5 runes (`$state/$derived/$props`), TS strict. Money is a **decimal string** — never
  parse to float for arithmetic; format for display only (`formatMoney` in ProductCard).

## Visual language for retail (the lock)
- **Price is the loudest element** on a product: JetBrains Mono, `--text`, larger weight. A
  sale shows `compareAtPrice` struck-through in `--text-dim` to the left of the live price.
- **Category** is a `.kicker` (mono uppercase, chartreuse dot). **Stock** is quiet mono in
  `--text-muted`; "Only N left" (≤5) goes chartreuse; sold-out is a vermillion overlay tag.
- **Cards**: `--bg-surface`, hairline border, hover → `--accent` border (matches EventCard).
- **The acid moment**: the primary commerce action (Add / Charge) is the ONE lime-filled
  surface on screen. Everything else is concrete + hairline. Restraint is the brand.

## Hero surfaces — BUILT by Opus (reference implementations)
1. `lib/components/shop/ProductCard.svelte` — the reused atom. Two variants:
   - `variant="storefront"` — image, category kicker, name, price/sale, stock, hover "Add".
   - `variant="pos"` — compact tappable tile (big price, name, no description) for the operator grid.
   - Props: `{ product: Product; currency: FiatCurrency; variant?; disabled?; onAdd?(product) }`.
2. `lib/components/shop/pos/ShopPos.svelte` — the headline tap-and-go POS. Owns UX/state only;
   the parent owns data/transport via callbacks (so funds code stays out of the view):
   - Props: `{ shop: Shop; products: Product[]; placeAndCharge: (lines: PosCartLine[], permissionId: string) => Promise<{ ok: boolean; code?: string; error?: string }>; }`
   - Flow: tap products → cart accrues with running total → "Charge" → identify customer
     (enter/scan their `permissionId`) → calls `placeAndCharge` → success ticket with pickup code.
   - The tap-and-go promise: NO per-round customer prompt — the customer authorised once at entry
     (the spend permission); each round is one operator tap. The screen makes that legible.

## To BUILD by Sonnet (against this spec)
- **Storefront** `lib/components/shop/Storefront.svelte` — responsive grid of
  `ProductCard variant="storefront"`, grouped by category (category label = `.kicker`),
  a sticky cart drawer/summary, empty/loading/error states (mirror `EventsGridSection`'s
  load-state pattern + `cache.ts` SWR).
- **Site section** `lib/components/site/sections/ProductGridSection.svelte` — mirror
  `EventsGridSection.svelte` exactly (bundled fetch, preview mode, cache TTL) but for products;
  register it in `SectionRenderer.svelte`. (Shared `Section` union needs a `productGrid` member —
  that's a shared-types add; flag for Opus if it touches anything beyond a plain section type.)
- **Cart + checkout** `lib/components/shop/Checkout.svelte` — line items, total, the rail
  picker (card / crypto), and the fees box. **Mirror `ClaimButton`'s fees + checkout structure**;
  reuse `api/shop-payment.ts` (online USDC signed-quote) and the Stripe path. Do NOT reinvent the
  payment calls.
- **Builder editor** — shop config + product CRUD tabs in `MultiSiteBuilder`; reuse existing tab
  patterns. Calls the step-1 shop CRUD endpoints (`POST/PUT/DELETE /api/shops/:id/products`, etc.).
- **POS shell/routing** — mount `ShopPos` behind operator auth on the creator side; wire
  `placeAndCharge` to `POST /api/shops/:id/orders` (rail "crypto") then
  `paySpendPermission(shopId, orderId, permissionId)` from `api/shop-spend-permission.ts`.
- **Grant UI** — the attendee "Tap to pay here" entry flow: `fetchSpendGrantParams` →
  `grantShopSpendPermission` (kernel-account, one passkey ceremony) → `registerSpendPermission`.
  This touches the Kernel/signature path — keep the call sequence exactly as written; if you change
  anything beyond wiring/markup, hand back to Opus.

## API surface already built (just call it)
- `api/shop-payment.ts`: `fetchShopPaymentQuote`, `buildShopPaymentTypedData`, `submitShopCryptoPayment`.
- `api/shop-spend-permission.ts`: `fetchSpendGrantParams`, `registerSpendPermission`,
  `paySpendPermission`, `revokeSpendPermission`.
- Step-1 shop CRUD + order endpoints in `apps/server/src/routes/shops.ts`.

## Reference patterns to mirror
- Card: `lib/attendee/events/EventCard.svelte`. Grid + load-states + cache: `EventsGridSection.svelte`.
- Fees/checkout/pay flow: `lib/components/events/ClaimButton.svelte`.
- Builder tabs: `lib/components/builder/MultiSiteBuilder.svelte`.
