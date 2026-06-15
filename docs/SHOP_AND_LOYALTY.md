# WoCo Shop + POD Loyalty

A merchant shop — catalog, web storefront, and a staff POS — settling in **USDC** on **Arbitrum
Sepolia (`421614`)**, with an on-chain loyalty layer. Built on the same event stack (series,
reservations, claims, site builder, smart wallets). Companion to
[`BUILDATHON_SUBMISSION.md`](./BUILDATHON_SUBMISSION.md).

---

## 1. One catalog, two front-ends

A **shop** is a catalog of **products**. Two front-ends consume the same catalog and order model:

- **Web shop** — customer self-serve, embeddable in the merchant's site-builder site (a
  `productGrid` section), or deployable as a standalone storefront.
- **POS** — a staff-operated skin of the same shop: staff assemble the cart, the customer authorises
  payment ("tap to pay"). Everything else (products, stock, orders, fulfilment, loyalty) is shared.

The data model mirrors events (`Shop`, `Product`, `ProductVariant`, `Order`, `OrderLine`) and is a
Shopify-aligned subset (products → variants, optional inventory, collections, sale price, SKU,
channel visibility). Catalog and orders are stored as Swarm feeds — no database.

## 2. Payment — USDC surfaced as £/$, plus card

Money spent is **USDC**, shown to the user in their fiat currency — there is **no separate points or
credit token**. The same USDC in the user's own wallet is spendable anywhere. Two rails, mirroring
events:

- **Card** — Stripe Connect (destination charge + webhook → order paid), the live rail today.
- **Crypto (USDC)** — two sub-flows:
  - **Per-order signed quote** (web shop / online): the server issues an HMAC-signed, one-shot quote
    committing to an exact USDC amount; payment is verified on-chain by exact amount + recipient +
    confirmations + payer binding, with tx-hash replay prevention — the same hardened flow events use.
  - **Spend permission (tap-and-go POS)** — the headline retail rail (see §3).

**Platform fee** is rail-differentiated and env-overridable (retail is operationally lighter than a
ticket sale): **card = 1.5%**, **crypto = 0.25%** to start, with a roadmap toward a flat micro-fee.
Custodial preloaded balances are explicitly out of scope (e-money regulation; breaks the
non-custodial model).

## 3. The spend-permission rail (capped, non-custodial)

At entry, an attendee's smart wallet grants a **capped, time-boxed Spend Permission** to the venue's
spender via a **ZeroDev Kernel session key** (a scoped, on-chain spend permission). Then:

- **USDC stays in the user's own wallet** until spent. Each order = the venue's session key draws the
  order amount gaslessly — no wallet popup per round.
- The draw is `USDC.transfer(merchant, amount)` from the user's Kernel (driving the Kernel's own
  balance), bounded **on-chain** by a call policy (`to` must equal the merchant, `value` ≤ a per-draw
  ceiling) plus a timestamp window and a draw-count rate limit. **A compromised terminal cannot
  exceed the cap, change the recipient, or spend outside the window.**
- The cumulative cap is enforced server-side (a single per-shop spender + per-permission mutex +
  one-shot settlement), with the on-chain per-draw bounds as the trustless backstop — this ZeroDev
  version has no on-chain cumulative-limit policy yet, and it is a drop-in when one lands. The
  per-shop spender key is derived deterministically and held server-side, architected for a clean
  swap to a POS-device or per-attendee spender later.
- **Void/refund** before settlement reuses the events partial-refund path.

Card-login users keep the per-order online quote flow; the tap-and-go spend-permission rail is
Kernel/Arbitrum-only by design (the chains are never mixed on the pull path).

This is the *same primitive* the [agent commerce surface](./WOCO_AGENT_ARCHITECTURE.md) builds on — an
agent's bounded budget and a festival tap-to-pay band are two faces of one capped, non-custodial
spend permission.

## 4. POD loyalty — derive points, mint badges

PODs are the ownable-asset layer, with one schema and a `kind` discriminator:
`ticket` · `badge` (loyalty) · `collectible` (drops) · `authenticity` (transferable cert; stubbed).

- **Points are derived, not stored** — `points = floor(Σ order.total × earnRate) − Σ redemptions`,
  a pure function of the existing order feed. A point is a decrementing redeemable balance; a POD is
  immutable — so points are never PODs and there is no per-point write.
- **Badges (PODs) mint only at spend milestones** — rare, durable, soulbound. Issuance signs a
  manifest and mints on-chain (sponsored).
- **USDC spend is also on-chain**, so it is trustlessly summable for portable, cross-merchant
  reputation; card spend stays in the merchant-trusted order feed (points are a merchant liability,
  not a trustless asset).

## 5. POD-holdings gating (events + products)

A claim or purchase can be gated on POD holdings (count-based, a specific manifest, or a time
window):

- A single shared **holdings primitive** (`holdsAtLeast` / `getHoldings`) unifies the on-chain slot
  owner and the collection feed, and is reused by event gating, product gating, and milestone
  eligibility.
- Events can gate **on-chain** (`WoCoEventV2`'s drop-gate hook) so the crypto-claim path needs no
  server in the gate; product gating is a server holdings check at order time. Multi-POD any/all
  gates with a time window are supported.

The holdings **read is already decentralised** (slot owner is public on-chain; the collection feed
reads from the Swarm gateway). Only enforcement at issuance is server-mediated — and only because
issuance already is (the platform feed-signing key + postage). The gate adds no new trust boundary.

## Honest state

- **Arbitrum Sepolia (testnet).** Go-live is a one-line USDC address swap (the test USDC has the
  same 6-decimal ERC-20 surface as Arbitrum One USDC).
- The **0.25% crypto fee is recorded but not yet collected** on the direct-transfer rail — splitting
  a single ERC-20 transfer non-custodially needs a forwarder/splitter (a later milestone); funds go
  in full to the merchant today rather than break the non-custodial model to collect a fee.
- Card (Stripe) is the live *card* rail for paying customers today; the USDC quote and
  spend-permission rails are built and **verified on-chain** (the standalone agent rail settles real
  USDC E2E — the agent/USDC path never touches Stripe), with the spend-permission cumulative cap
  enforced server-side as described above. Crypto is intentionally **held back from real customers
  until a security audit** (not yet done).
- The agentic (x402) purchasing hook converges on the same verified-transfer settlement; the
  standalone agent rail is verified on-chain (see [`WOCO_AGENT_ARCHITECTURE.md`](./WOCO_AGENT_ARCHITECTURE.md)).
