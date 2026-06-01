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
- `Product` — { productId, shopId, name, description, imageRef, price, category,
  variants[], stock?(number — OMIT = unlimited), podRewards?[], active }
- `ProductVariant` — { variantId, label (e.g. "Large"), priceDelta }  (flat only in p1;
  prep-changing modifiers are the fast-food rabbit hole — deferred)
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

## 5. Security invariants

- Spend permission cap + window are the drain ceiling; verify on-chain before fulfilment.
- Server uses the VERIFIED payer address, never one from the request body (as claims do).
- USDC amount is exact-match against a server-signed quote (no oracle slippage), as today.
- txHash/spend replay prevention: file-backed consumed set, as `consumed-tx-hashes.json`.
- Reservation hold for finite stock; per-series mutex serialises writes (as events).
- Card path: Stripe signed webhooks only in prod; session-id replay prevention.

## 6. Build order (phases)

1. **Catalog + order model** — shared types + feeds + server CRUD.  *(Opus — data model)*
2. **USDC spend-permission rail** + Stripe parallel — the security-critical core.  *(Opus)*
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
