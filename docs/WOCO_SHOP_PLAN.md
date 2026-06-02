# WoCo Shop — Plan & Locked Model

Status: DRAFT for sign-off (2026-06-01). One catalog, two front-ends. Sits on the
event stack: reuses series/reservation/claim machinery, the site builder, PODs,
Stripe Connect, and the smart-wallet/session-key work.

Scope phase 1: static catalog ("menu") + ordering. NOT fast food (prep/cook state
machines) — deferred to a later phase. Pre-order = "order + short code", no prep states.

## 1. Core abstraction

A **shop** is a catalog of **products**. Two front-ends consume the same catalog and
order model:

- **Web shop** — customer self-serve, embedded in the merchant's site-builder site.
- **POS** — staff-operated skin of the same shop; staff assembles the cart, customer
  authorises payment. POS is the shop with the operator on the counter side.

Only two things differ between them: who assembles the cart, and how payment is
authorised. Everything else (products, stock, orders, fulfilment, loyalty) is shared.

## 2. Payment model (LOCKED)

Money spent is **USDC**, surfaced to the user as £/$ — they never need to know it's
crypto. There is NO separate points/credit token. "Spend at the festival, then the
coffee shop" = the same USDC in the user's own wallet, spendable anywhere.

### Platform fee (LOCKED 2026-06-02, differentiated by rail)
Retail is operationally lighter than a ticket sale (no mint/POD/PNG/email/sponsor gas —
just a feed flip), so the WoCo fee is lower and rail-dependent:
- **Card = 1.5%** (`PLATFORM_FEE_BP=150`), merchant absorbs. Matches events; covers the
  heavier Stripe-bound path. Already wired in the 2b checkout.
- **Crypto (USDC) = 0.25% to start** (25 bps), with a roadmap to ratchet toward a flat
  micro-fee (~1p/£1–10k) as volume grows. Both rates MUST be config constants
  (env-overridable) so they can be reduced over time without a rebuild.
- **Fee bearer = merchant absorbs only** for now. Leave a per-shop `feeMode: "absorb" |
  "pass"` field defaulting to `absorb` so "customer pays" is a later UI toggle, no schema
  migration. NOTE: passing *card processing* fees to consumers is banned in UK/EU — `pass`
  may only ever surface a transparent WoCo *service* fee, never a raw Stripe-cost surcharge.
- **Crypto fee collection is a 2c design decision:** a single ERC-20 transfer can't split
  merchant/platform non-custodially. The 0.25% belongs on the escrow/splitter or Stylus
  aggregator path — NOT by routing funds through a WoCo address. Recommendation: the online
  direct-transfer quote verifies *full amount to merchant* at launch; apply the 0.25% split
  once escrow/aggregator lands. Do not break the non-custodial thesis to collect a fee.

Two rails, mirroring events:

- **Card** — Stripe Connect (existing destination-charge + webhook claim flow).
- **Crypto (USDC)** — two sub-flows:
  - **Per-order approval** (web shop / online): signed-quote flow, as events do today.
  - **Spend permission (tap-and-go, festival POS)** — the headline rail:
    - At entry the attendee's smart wallet (Coinbase Smart Wallet / Kernel) grants a
      **capped, time-boxed Spend Permission** (ERC-7715-style session key) to the
      venue's spender key: "pull up to £X USDC during this event".
    - USDC **stays in the user's wallet** until spent. The venue can pull only up to
      the cap, only in-window, and the user can revoke. The cap is the anti-drain
      guarantee — a compromised terminal cannot exceed it.
    - Each bar order = the venue's session key pulls the order amount. Gasless via
      paymaster. No wallet popup per round.
    - **Void/refund** before settlement: staff can cancel an order; partial refund
      uses the same path as Stripe partial refunds.
    - **Offline/flaky signal**: an order is a signed spend intent; capture locally,
      settle the pull on reconnect. (Phase 2 hardening.)
- **Wristband/keycard (later HW layer)**: carries *which wallet* + a local auth secret
  to trigger the session-key spend. NOT a custodial top-up — funds stay non-custodial;
  the band is a "scan to identify + authorise" token over the spend-permission model.

Custodial preloaded balances are explicitly OUT (e-money/money-transmission regulation;
breaks the non-custodial thesis).

**Agentic purchasing (x402)** — third authorisation mode on the same USDC rail, NOT a
separate concept. The order endpoint speaks HTTP 402: an agent requests an order, gets
402 + payment requirements, pays USDC, retries with `X-PAYMENT`. No human/popup. Settles
USDC on-chain so it accrues loyalty like any crypto spend. Hooks left now (`PaymentRail`
"x402" + `OrderPayment.x402Header`); full build is a later phase. Mirrors the existing
event `PaymentProof` x402 slot.

## 3. Data model (sketch — to be finalised in `packages/shared/src/shop/types.ts`)

Mirrors event/series + PaymentConfig conventions (lowercase addrs, Hex64 refs, ULIDs).

- `Shop` — { shopId(ULID), ownerAddress, name, currency(FiatCurrency), categories[],
  paymentConfig(reuse PaymentConfig), createdAt }
- `Product` — { productId, shopId, name, description, imageRef, imageRefs?, price,
  compareAtPrice?(sale), sku?, category, variants[], stock?(OMIT = unlimited),
  channels?(web|pos — OMIT = both), podRewards?[], active }
- `ProductVariant` — { variantId, label (e.g. "Large"), priceDelta, stock?, sku? }
  (flat only in p1; multi-dimension option matrix (Size×Colour) + prep-changing
  modifiers deferred — flat variants also suit the POS tappable grid)

Shopify-aligned subset (products→variants, optional inventory tracking, collections=
categories, sale price, SKU, channel visibility). `channels` ties the one catalog to both
the web shop and the staff POS. Multi-option variant matrix is the main deferred parity gap.
- `Order` — { orderId, shopId, code(short human-readable), lines[], total, currency,
  paymentRail("card"|"crypto"), payment(proof/quote), status, fulfilledAt?, buyerRef }
- `OrderLine` — { productId, variantId?, qty, unitPrice }

Stock: optional per product. Finite-stock items (limited vinyl, capped merch) reuse the
**reservation → claim** flow verbatim. Unlimited items (a pint) skip reservations.

### Feeds
- `woco/shop/config/{shopId}`              → Shop JSON
- `woco/shop/{shopId}/products[/pN]`       → product catalog (paged like editions)
- `woco/shop/{shopId}/orders[/pN]`         → order log
- `woco/shop/creator/{ethAddress}[/pN]`    → merchant's shop directory (mirrors sites)
- Site builder: new `shop`/`productGrid` Section + optional `MenuSection`.

## 4. Loyalty (POD badges)

- A POD is issued **to a wallet**, at **milestones** — threshold- or item-triggered.
  e.g. "cumulative spend £50 → Festival Regular"; "bought limited vinyl → Collector".
  NOT one per purchase.
- **Progress between milestones is derived, not stored.** Every crypto spend is an
  on-chain USDC transfer, so cumulative (customer, merchant) spend is chain-readable.
  No separate balance ledger to trust/corrupt.
- **Aggregator**: the planned Stylus aggregator sums spend and gates POD issuance at
  thresholds. Card (Stripe) spend isn't on-chain → accrues via a server-signed
  attestation feeding the same aggregator (two input sources, one tally).
- POD issuance reuses existing rails (`woco.manifest.v1` ed25519 + Merkle batch).

## 4b. Decentralization posture (client-first)

Server is the "needs a server secret / shared durable state" carve-out only. Feed writes
need both the platform feed-signing key (`FEED_PRIVATE_KEY`) and the postage batch — both
server-only — which is exactly why events/sites/profiles write through the server. The shop
inherits that same constraint, NOT a new one.

- **Server-only (stays):** Stripe (secret + webhooks), postage, HMAC payment-quote signing,
  on-chain/x402 verification, email.
- **Reads are decentralizable now:** a deployed web shop can read the product feed straight
  from the Swarm gateway; the GET endpoints are an optional cache, not a requirement.
- **Pricing is pure:** move `priceOrder` + money helpers from `apps/server/src/lib/shop/`
  into `packages/shared` (step 2) so the CLIENT prices/validates locally (UX) and the
  server/payment-verification only re-checks the final amount (trust — defense in depth).
- **Writes migrate cleanly:** when client-side feed signing lands (see
  signing_role_architecture), catalog/order writes move client-side — same types, same
  topics, the user's scoped key signs instead of the platform key. The server endpoints are
  thin relays specifically so this is mechanical, not a rewrite.

**Agentic inventory (hook only for now):** an agent adding stock is the write-side twin of
x402 purchasing. Reserve a `shop:manage` session-delegation scope so a scoped session key
(ZeroDev) grants an agent catalog-write capability limited to one shop. The catalog API is
already machine-clean (JSON in/out, header auth). Build the agent flow later.

## 5. Security invariants

- Spend permission cap + window are the drain ceiling; verify on-chain before fulfilment.
- Server uses the VERIFIED payer address, never one from the request body (as claims do).
- USDC amount is exact-match against a server-signed quote (no oracle slippage), as today.
- txHash/spend replay prevention: file-backed consumed set, as `consumed-tx-hashes.json`.
- Reservation hold for finite stock; per-series mutex serialises writes (as events).
- Card path: Stripe signed webhooks only in prod; session-id replay prevention.

## 6. Build order (phases)

1. **Catalog + order model** — shared types + feeds + server CRUD.  *(Opus)* ✅ DONE
   (branch `feat/woco-shop`, commits 5f06144 + 93a9c3e). Shared model
   (`packages/shared/src/shop/{types,topics}.ts`), server service
   (`apps/server/src/lib/shop/service.ts`) + routes (`apps/server/src/routes/shops.ts`,
   mounted `/api/shops`). Builds clean; NOT yet deployed/tested against live bee.
2. **USDC spend-permission rail** + Stripe parallel — the security-critical core.  *(Opus)*
   - (a) ✅ DONE (237c580) — `priceOrder` + money helpers → `packages/shared/src/shop/pricing.ts`.
   - (b) ✅ DONE (6fd8c87 + 5d2c4f0) — Stripe card checkout + webhook → order pending→paid.
   - (c pt1) ✅ DONE (d61a85d server + 0e51e58 client) — USDC online per-order signed-quote flow.
     `lib/shop/quote.ts` (HMAC one-shot, `woco-shop-quote-v1`, `.data/consumed-shop-quotes.json`);
     `POST /orders/:orderId/quote` (fiat→USDC, FULL amount to merchant); `api/shop-payment.ts`.
   - (d) ✅ DONE (d61a85d) — on-chain verify + replay. `POST /orders/:orderId/pay-crypto` reuses
     events `verifyPayment` (exact amount + recipient + confirmations + tx.from) + tx-registry
     one-shot. Payer binding = EIP-712 `SHOP_PAYMENT` (anonymous) OR session `parentAddress`
     (logged-in = 1 prompt). Security-reviewed clean 2026-06-02 (no HIGH/MED findings).
   - (c pt2) ✅ DONE (Opus, not deployed/tested vs live bee) — POS spend-permission (capped,
     time-boxed) draw via **ZeroDev Kernel session keys** on Arb Sepolia, gasless via the paymaster.
     GRANT: attendee names the venue spender via `addressToEmptyAccount` (ERC-7710 delegation),
     sudo-signs once, `serializePermissionAccount` → approval blob (no private key). DRAW: server
     holds the per-shop spender (`HMAC(SHOP_SPENDER_SECRET, shopId)`), `deserializePermissionAccount`
     + gasless `USDC.transfer(merchant, amount)` userOp; verifies the on-chain Transfer log + flips
     the order. Files: shared `SpendPermissionGrantParams`/`RegisterSpendPermissionRequest`/
     `ShopSpendPermission`; client `kernel-account.grantShopSpendPermission` + `api/shop-spend-permission.ts`;
     server `lib/shop/spend-permission.ts` + 4 routes (grant-params/register/pay-spend-permission/revoke).
     CORRECTIONS vs the original sketch (crypto-reviewed): (1) the draw is `transfer`, NOT
     `transferFrom` — the session key drives the Kernel's OWN balance (`transferFrom(self,…)` would
     need a self-allowance); (2) this `@zerodev/permissions@5.6.3` has NO on-chain spending-limit
     policy, so the cumulative cap is enforced SERVER-SIDE (sole spender + per-permission mutex +
     `spentAtomic`) with the on-chain policy as the trustless backstop: call-policy `to`==merchant
     (EQUAL) + `value`<=per-draw ceiling (LTE) + timestamp window + rate-limit count. A leaked
     spender key can only over-charge the merchant within those bounds (refundable, balance-capped),
     never redirect funds or spend out-of-window. Cumulative-cap → on-chain is a drop-in when a
     spending-limit hook lands (same `transfer` shape). Settlement is one-shot per order
     (`.data/shop-settled-orders.json`) so a Swarm order-write failure can't trigger a re-draw.
     ENV: `SHOP_SPENDER_SECRET` (stable, protect like FEED_PRIVATE_KEY — rotating it changes every
     shop's spender address and orphans live approvals) + `ZERODEV_RPC` (server bundler+paymaster).
     Custody is server-held now but architected for a clean swap to POS-device/per-attendee spender
     (the approval just names a different address; only `drawSpendPermission` moves). Frontend
     integrity (omnipin) for the grant UI = noted hook for the World Computer Registry milestone.
     AGENTIC/x402 hook left: spend-permission + a future `pay-x402` converge on the same verified-
     transfer→paid terminal (`OrderPayment.x402Header` + rail "x402" already in the schema).
   - (e) ✅ DONE (Opus) — reserved `shop:manage` scope (HOOK ONLY, not enforced). Shared:
     `SHOP_MANAGE_SCOPE` + `ScopedShopCapability` ({scope, shopId}). Server: single catalog-write
     seam `canManageShop(owner, parent, shopId)` — all four catalog/config write owner-checks
     (create/update shop, PATCH shop, POST/DELETE product) now route through it, so the future
     scoped-token check slots in at ONE site. Orders/funds stay owner-only. Enforcement is deferred
     (needs an authenticated `scope` in the AuthorizeSession EIP-712 payload = versioned
     SESSION_DOMAIN bump; not done so live sessions don't break).
   Crypto fee LOCKED: 0.25% recorded (`CryptoFeeConfig`/`cryptoFeeBp`) but NOT collected on the
   direct-transfer rail — split moves to a non-custodial `pay(merchant,amount,orderRef)` forwarder
   (escrow/splitter milestone) which also gives immutable on-chain order binding (0 sign prompts).
3. **Web shop UI + staff POS skin** — same catalog, two front-ends; tap-and-go on rail.  *(Sonnet — mechanical component build; back to Opus for any signature/funds code)*
4. **POD loyalty milestones** — listen to spend events, issue badges via aggregator.  *(Opus review on crypto touches)*

### Model split (token economy)
Opus through steps 1–2 (data model + signature/funds protocol — expensive to get wrong,
cheap as a fraction of the build). Switch to **Sonnet** at step 3 once the spec is locked
and work is mechanical (Svelte components, CRUD endpoints, wiring existing patterns).
Opus reviews anything touching signatures, spend permissions, or funds.

## 7. Decisions (step 2, 2026-06-02) + open items

RESOLVED:
- **Test USDC = Circle native test USDC on Arbitrum Sepolia** `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`
  (faucet.circle.com, 20/2h). Earlier "no testnet USDC" note was wrong. Same 6-dec ERC-20
  surface as Arb One mainnet `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` → go-live is a
  one-line address swap. Both live in `USDC_ADDRESSES` (packages/shared/src/event/types.ts).
- **Spend Permission SDK = ZeroDev Kernel session keys** (NOT Coinbase native Spend Permissions).
  Reasons: Kernel is deployed on Arbitrum (the buildathon chain) and we already run it there
  end-to-end with a gasless paymaster ([[project_zerodev_passkey]]); Coinbase Spend Permissions
  are a Base-only primitive (CSW contracts live on Base — [[feedback_csw_signs_on_base]]) and
  would force the pull rail onto Base. Cap = spending-limit policy; window = timestamp policy;
  target = call policy pinned to USDC.transferFrom. ZeroDev co-authored ERC-7715, so this IS
  the standard. CSW-login users keep the per-order online signed-quote flow (any chain); the
  tap-and-go spend-permission rail is Kernel/Arbitrum only — never mix chains on the pull path.

### Fiat onramp (separate axis from the pull rail — applies to ALL login types)
How USDC gets INTO the wallet, independent of how the venue pulls it. Both CSW and passkey
(Kernel) users can onramp: CSW ships Coinbase's built-in onramp; passkey users use Coinbase
Onramp (funds any address on a supported chain) or Stripe Onramp (we already run Stripe).
CAVEAT: onramps are mainnet/production only — testnet wallets fund via the Circle faucet, so
onramp is a go-live integration, not a buildathon demo. Leave an "Add funds" hook now.

### Yield on held balances (deferred phase — design kept open)
Non-custodial yield: the held balance is a yield-bearing USDC form (Aave aUSDC / ERC-4626 vault
share) that accrues to the USER in their own wallet; the session key redeems-and-transfers at
spend time. Custodial preload earning yield = deposit-taking/e-money (regulated) — stays OUT.
To keep this open without building it: step 2 puts USDC behind a per-chain "spend token" config
and keeps the spend-permission call-policy target swappable, so "held balance = vault share,
spend redeems on the fly" is a later phase, not a rewrite. Sits alongside x402 + Stylus aggregator.

OPEN:
- Variant/category UX in the builder — defer detail to step 3.
