# WoCo Shop — Opus handover (Sonnet → Opus, step 3 completion + step 4)

Branch: `feat/woco-shop` — NOT pushed/deployed. Head: `d783fc1`.

## What Sonnet shipped (step 3 UI, both commits)

All components build clean (`npm run build:web`). Design language = Concrete & Acid throughout.

| File | Description |
|------|-------------|
| `packages/shared/src/site/types.ts` | `ProductGridSection` added to `Section` union |
| `apps/web/src/lib/api/shops.ts` | Shop CRUD client — `getShop`, `getProducts`, `getMyShops` (authGet), `createShop`, `updateShop` (authPatch), `upsertProduct`, `deleteProduct` (authDelete), `createOrder`, `createOrderAuth` |
| `apps/web/src/lib/api/client.ts` | `authPatch` added |
| `apps/web/src/lib/api/stripe.ts` | `createShopCheckout(shopId, orderId, returnUrl?)` added |
| `apps/web/src/lib/cache/cache.ts` | `TTL.SHOP_PRODUCTS` (5 min), `TTL.CREATOR_SHOPS` (24h), `cacheKey.shopProducts`, `cacheKey.creatorShops` |
| `apps/web/src/lib/components/shop/Storefront.svelte` | Responsive product grid, category kickers, sticky cart bar |
| `apps/web/src/lib/components/shop/Checkout.svelte` | Cart + rail picker (card/USDC) + fees box + Stripe wired; **USDC on-chain stubbed** (see open items) |
| `apps/web/src/lib/components/site/sections/ProductGridSection.svelte` | Site section: SWR cache, bundled fetch, shimmer skeletons |
| `apps/web/src/lib/components/site/sections/SectionRenderer.svelte` | `productGrid` branch registered |
| `apps/web/src/lib/creator/builder/tabs/ShopTab.svelte` | Shop config (name/currency/categories CRUD) + product CRUD in builder |
| `apps/web/src/lib/creator/builder/MultiSiteBuilder.svelte` | Shop tab added; per-site `siteShopId` persisted in localStorage |
| `apps/web/src/lib/creator/shops/MyShopsScreen.svelte` | Merchant shop list with "Open POS" button |
| `apps/web/src/lib/creator/shops/ShopPosShell.svelte` | Auth gate + data loader; wires `placeAndCharge` → `createOrderAuth` + `paySpendPermission` |
| `apps/web/src/lib/attendee/shop/SpendGrantModal.svelte` | "Tap to pay" flow — `fetchSpendGrantParams` → `auth.grantSpendPermission` (passkey) → `registerSpendPermission` → permissionId display |
| `apps/web/src/lib/auth/auth-store.svelte.ts` | `grantSpendPermission` wrapper exported (thin — calls `kernel-account.grantShopSpendPermission` with `_kernel`; passkey-only) |
| `apps/web/src/lib/router/router.svelte.ts` | `/creator/shops` → `my-shops`; `/creator/shops/:shopId/pos` → `shop-pos` |
| `apps/web/src/CreatorApp.svelte` | `MyShopsScreen` + `ShopPosShell` wired to routes |

## Open items for Opus

### 1. USDC on-chain transfer in Checkout (step 3b — funds code)

`Checkout.svelte` has a clear stub at the crypto path:

```ts
// TODO (Opus, step 3b): call executeShopUSDCTransfer(quote) → settleCryptoOrder(proof)
throw new Error("USDC payment requires a connected smart wallet. Use card for now.");
```

Need a `executeShopUSDCTransfer(quote: ShopPaymentQuote): Promise<string>` function (returns txHash) that:
- Switches to `quote.chainId`
- Looks up the USDC address for the chain (already in `USDC_ADDRESSES` in shared)
- Calls `erc20.transfer(quote.recipient, BigInt(quote.amountAtomic))`
- Returns the txHash

Then in Checkout.svelte replace the TODO with:
```ts
const { executeShopUSDCTransfer } = await import("../../payment/shop-usdc-pay.js");
const txHash = await executeShopUSDCTransfer(quote);
const { submitShopCryptoPayment } = await import("../../api/shop-payment.js");
const settled = await submitShopCryptoPayment({ shopId, orderId, txHash, chainId: quote.chainId, quote });
```

This is simpler than the event payment (no escrow, no ETH path) but still touches on-chain funds.

### 2. SectionEditor — productGrid case (builder UX)

`apps/web/src/lib/creator/builder/SectionEditor.svelte` needs a `productGrid` case.
It should render:
- ShopId picker (select from merchant's shops, or paste a shop ID)
- `max` number input (optional)
- `categoryId` picker (load from selected shop's categories)

Mirror the `eventsGrid` case in SectionEditor for the pattern.

### 3. SpendGrantModal entry point (attendee UX)

`SpendGrantModal.svelte` is built and correct but has no entry point in the attendee UI.
It should surface at:
- Event page (if the event's venue has a shop with a spend-permission rail) — an "Activate tap-to-pay" button near the ClaimButton
- Or a dedicated `/shops/:shopId/tap` attendee route

Design decision: where does this appear? Surfacing it contextually at the event page is the most natural for the festival scenario. But it needs a shop↔event linkage (the site builder's shop tab already links a shopId to a site; the event to site link exists via `SiteEventsIndex`).

### 4. POD loyalty milestones (step 4)

On-chain USDC spend → aggregator → badge issuance at thresholds. Design in `docs/WOCO_SHOP_PLAN.md §4`.

### 5. Minor: MultiSiteBuilder tab type duplication

`MultiSiteBuilder.svelte` has `tab` state typed twice (once on the `let tab = $state<...>` declaration and once in `type TabId`). They're in sync but the initial state declaration (`let tab = $state<'template' | ... | 'domain'>`) is now inconsistent since `TabId` is the canonical type — tidy up by using `let tab = $state<TabId>('brand')`.

## Design rules reminder (for any further shop work)

- Concrete & Acid: `var(--token)` only, hairline 1px borders, max `--radius-md`, dense layouts
- `--accent` (lime `#C7F23A`) = ONE action colour; text on it always `--accent-ink` (#0B0B09)
- `--font-mono` for all prices/codes/amounts
- No `rounded-2xl`, no big shadows, no generic look
- Use `/frontend-design` skill for any new screen/component

## How to continue

```
# Fresh Opus chat, on branch feat/woco-shop
READ: docs/SHOP_OPUS_HANDOVER.md (this file)
READ: docs/WOCO_SHOP_PLAN.md
READ: memory/project_woco_shop.md
READ: docs/SHOP_UI_SONNET_HANDOVER.md (original Sonnet spec for context)
RULE: Any signature/funds/spend-permission/Kernel change = this chat
```
