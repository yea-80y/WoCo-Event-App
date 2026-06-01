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
2. **USDC spend-permission rail** + Stripe parallel — the security-critical core.  *(Opus — NEXT)*
   Tasks: (a) move `priceOrder` + money helpers to `packages/shared` (client-first); (b) Stripe
   checkout + webhook → order pending→paid (reuse events' Stripe Connect); (c) USDC: online
   per-order signed-quote flow, then POS spend-permission (capped, time-boxed) draw; (d) on-chain
   verification + replay prevention; (e) reserve `shop:manage` session scope. Decide first:
   test-USDC token on Arb Sepolia; Spend Permission SDK (Coinbase native vs ZeroDev session keys).
3. **Web shop UI + staff POS skin** — same catalog, two front-ends; tap-and-go on rail.  *(Sonnet — mechanical component build; back to Opus for any signature/funds code)*
4. **POD loyalty milestones** — listen to spend events, issue badges via aggregator.  *(Opus review on crypto touches)*

### Model split (token economy)
Opus through steps 1–2 (data model + signature/funds protocol — expensive to get wrong,
cheap as a fraction of the build). Switch to **Sonnet** at step 3 once the spec is locked
and work is mechanical (Svelte components, CRUD endpoints, wiring existing patterns).
Opus reviews anything touching signatures, spend permissions, or funds.

## 7. Open items
- Test USDC on Arbitrum Sepolia for the buildathon (no native Circle USDC on testnet —
  need a mock/bridged token address). Decide before step 2.
- Exact Spend Permission API surface (Coinbase SDK vs ZeroDev session keys) — pick in step 2.
- Variant/category UX in the builder — defer detail to step 3.
