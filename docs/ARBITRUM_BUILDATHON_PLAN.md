# Arbitrum Open House Buildathon — WoCo Plan

Three-week build for the Arbitrum Open House London Buildathon
(2026-05-25 → 2026-06-15). Submission target: $30k prize pool +
Founder House placement + follow-on grant programme.

Date: 2026-05-24. Author: nabil + claude planning session.

---

## TL;DR

**WoCo is an open commerce protocol going after the platform-tax
model.** Ticketmaster takes 20-30% on top of face value. OnlyFans
takes 20% of every subscription. Apple takes 30% of every app
purchase. Uber takes ~25% of every fare. YouTube takes 45% of ad
revenue. These platforms exist because they own identity, payment
rails, and discovery. WoCo unbundles all three on Arbitrum: identity
is your self-custodial wallet, payments are USDC, discovery is
on-chain event logs anyone can index. The platform fee drops to the
actual cost of infrastructure, which on Arbitrum is fractions of a
cent.

One protocol handles any discrete, sequential commerce — events,
merch, food orders, bookings, hire-out slots, queues, **creator
subscriptions, paid content, gig marketplaces, service matching**.
Users hold their own funds in a self-custodial smart wallet that
earns yield while idle. Any AI agent can transact on the protocol
via an open standard.

Three weeks to ship four workstreams compounding on existing WoCo
infrastructure:

1. **Arbitrum-native commerce primitive** — `WoCoStore.sol` registry
   contract, sibling of the existing `WoCoEvent.sol`. One contract,
   infinite stores, infinite product lines, zero redeploys.
2. **WoCo Wallet** — self-custodial smart wallet (Coinbase Smart
   Wallet / passkey-based), fiat onramp via Coinbase Pay, sponsored
   gas via ERC-4337 paymaster, opt-in Aave yield on idle USDC.
3. **Stylus hot-path** — `claimFor` / `batchClaimFor` / `buyProduct`
   ported to Rust → WASM. Side-by-side gas benchmarks vs Solidity for
   the pitch.
4. **Agent surface** — OpenAPI spec, `.well-known/agent.json`, MCP
   server. Demo agent (LangChain or AgentKit) buying a ticket
   end-to-end as the showcase.

Stretch: Timeboost for organiser drop priority. Cross-chain USDC
settlement (CCTP).

## Pitch narrative

> WoCo is the open commerce protocol that goes after the rent-seeking
> middlemen of the digital economy. The same primitive that handles a
> Glastonbury ticket handles an OnlyFans subscription, a Deliveroo
> order, an Uber ride, and a YouTube super-chat — because they're all
> discrete sequential allocations with payment underneath. Today
> centralised platforms own that layer and tax 20-50% for the
> privilege. WoCo replaces the middleman with an open protocol on
> Arbitrum: organisers and creators keep their money, users own their
> identity and their funds, and AI agents can transact on the protocol
> via an open standard.
>
> Built on Arbitrum because Arbitrum is where native USDC, mature
> DeFi, sub-cent gas, Stylus, and Timeboost all converge. Built open
> because commerce infrastructure that excludes is commerce
> infrastructure that loses.

## Why this is genuinely Arbitrum-native (not just deployed there)

- **Native USDC** — wallet holds Circle-issued USDC, no bridge risk
- **Mature DeFi** — Aave / Compound on Arbitrum for yield
- **Sub-cent gas** — makes a per-pint stablecoin payment economically rational
- **Stylus** — Rust hot-path for the commerce primitive (genuine cost
  reduction, demonstrable benchmark)
- **Account abstraction ecosystem** — ERC-4337 paymasters, Coinbase
  Smart Wallet, Circle's USDC paymaster all first-class
- **Timeboost** — organiser-paid priority inclusion for hot drops
  (Glastonbury-style ticket releases, sneaker drops)

---

## Current state of WoCo (what we're building ON)

What's already shipped and live on production:

- **Off-chain ticketing** — Swarm feeds, ed25519 PODs, per-series mutex
- **On-chain ticketing** — `WoCoEvent.sol` deployed on Base Sepolia
  (`0x00824e220571d09d1c3d9b68a8f4c5423d166780`), wired into
  `apps/server/src/routes/events.ts:524`, sponsor-wallet pattern in
  `apps/server/src/lib/chain/sponsor-wallet.ts`
- **Crypto payment CODE + escrow contract** — ETH + USDC verification,
  HMAC-signed quotes, `WoCoEscrow.sol` (written + tested, passes our
  suite), replay protection. Contract needs changes + a security audit
  before production. Code path NOT exposed to buyers — Stripe is the
  only payment method live today. Buildathon enables crypto payments
  for the first time AND gives us the deploy reason to harden the
  contract.
- **Stripe payments** — Connect Express, destination charges, webhook
  auto-claim, reservation system with file-backed mutex
- **Site builder** — multi-page builder, theme tokens, deployed as
  standalone BZZ collections on Swarm with per-site ENS routing
- **Order forms** — encrypted (SealedBox) PII capture for events
- **Slot reservations** — file-backed `.data/reservations.json`,
  per-series mutex, per-browser dedup via `X-Client-Key`

What this means: we're not building from scratch. The contract pattern,
sponsor wallet, payment verification, reservation system, and frontend
auth all exist. The buildathon is about extending the primitive
(`WoCoStore`), adding a chain (Arbitrum), adding a funding model
(WoCo Wallet), porting the hot-path (Stylus), and exposing the API
to a new consumer (agents).

---

## Scope and non-scope

### IN SCOPE

- `WoCoStore.sol` — registry contract for discrete sequential commerce
- Arbitrum One mainnet deploy + Arbitrum Sepolia staging for both
  `WoCoEvent` and `WoCoStore`
- WoCo Wallet flow: create smart wallet, fiat onramp, top-up, spend
  at WoCo events/stores, view balance
- Aave integration: visible in UI, working on testnet, opt-in toggle
- Stylus port of `WoCoStore` hot path (`buyProduct`, `batchBuy`)
- Side-by-side Solidity vs Stylus gas benchmark in the pitch
- OpenAPI spec for existing endpoints + new `/api/agent/*` surface
- MCP server wrapping the agent endpoints
- Demo agent script (LangChain or AgentKit) that buys a ticket
  end-to-end
- Store frontend builder UI — new section types in MultiSiteBuilder
- Three demo verticals on the showcase site: ticketing, merch store,
  food order-ahead

### OUT OF SCOPE (explicit)

- Physical fulfilment automation (carrier API integration, label
  printing) — flat-rate shipping cost in MVP
- Returns processing automation — manual organiser flow only
- Production Aave routing — testnet demo only; production needs
  security audit (deferred to post-buildathon)
- Custodial alternative to smart wallet — self-custodial only
- Migrating existing Base Sepolia events to Arbitrum — Arbitrum is
  additive, not a replacement
- Self-hosted Swarm music storage for artist profiles — Spotify /
  SoundCloud embed as MVP. Pending collaboration with a music-on-Swarm
  developer that owner is reaching out to; if that lands, self-hosted
  Swarm music moves IN to scope as a tier 2 item
- User-owned Swarm feeds for artist profiles — designed for, not
  shipped. Profile schema must be portable so post-buildathon migration
  to user-owned feeds is non-breaking
- Production mainnet escrow deployment — escrow hardening contract
  (post-event timestamp + cancel/refund) ships to Arbitrum Sepolia for
  demo, NOT to mainnet for real money. Audit + mainnet are
  post-buildathon
- Production Timeboost integration — research + stretch goal only
- Full cross-chain USDC settlement via CCTP — stretch goal, single
  chain pair max
- Building a new agent framework — we use existing ones (AgentKit,
  LangChain) and expose a surface they can call
- Removing email-based claim flow — agent path adds to it, doesn't
  replace it

### POST-BUILDATHON (for the pitch roadmap slide)

- Production Aave yield routing (with audit)
- Stripe Crypto onramp as alternative to Coinbase Pay
- ERC-4337 → Circle USDC paymaster migration (off sponsorship)
- Additional commerce verticals (bookings, hire-out slots, queues)
- Cross-chain liquidity via CCTP at scale
- Mobile-first wallet PWA

---

## Architecture overview

### Contract layer (Arbitrum One)

```
WoCoEvent.sol         existing  registry: events + slots
WoCoStore.sol         new       registry: stores + products + stock
WoCoEscrow.sol        existing  payment escrow (already chain-agnostic)
ContentHashRegistry   existing  on-chain content hash registry (already deployed)
```

All four contracts are stateless registries — no per-event or
per-store contract deployment. Organisers pay one tx to register, one
tx per product line. No redeploys ever.

### Settlement layer

```
Arbitrum One           primary chain for buildathon
Arbitrum Sepolia       staging
Base mainnet           existing (unchanged)
Optimism mainnet       existing failover (unchanged)
```

WoCo Wallet defaults to Arbitrum One. Existing payment paths on
Base/OP continue working — Arbitrum is additive.

### Wallet layer

```
Coinbase Smart Wallet       passkey-based, ERC-4337, gasless
  ↓
USDC balance (Arbitrum)
  ↓
Opt-in: Aave deposit         yield on idle
  ↓
Spend at WoCo               (gasless via paymaster)
```

### Agent layer

```
Agent (Claude / GPT / AgentKit / LangChain / custom)
  ↓
MCP server (apps/server/src/agent/mcp.ts)
  ↓
/api/agent/* endpoints (wrap existing /api/events, /api/store, /api/payment)
  ↓
Same business logic as human UI
```

---

## Workstream 1 — `WoCoStore.sol` + Arbitrum deploy

**Owner candidate**: extra dev #1 (frontend builder UI) + you/me (contract).

### Contract shape

```solidity
contract WoCoStore is Ownable2Step {
    struct Store {
        address organiser;
        bytes32 manifestRef;        // Swarm ref → store metadata (name, theme, policies)
    }

    struct Product {
        uint128 supply;             // total ever offered (immutable after add)
        uint128 sold;               // monotonic counter
        bytes32 manifestRef;        // Swarm ref → product metadata (name, images, variants, price)
        uint64  flags;              // bit 0: active, bit 1: requires shipping address, ...
    }

    mapping(bytes32 => Store)                              public stores;
    mapping(bytes32 => mapping(bytes32 => Product))        public products;
    mapping(bytes32 => mapping(bytes32 => mapping(uint128 => bytes32))) public orderRef;
    // orderRef[storeId][productId][orderSlot] = Swarm ref to encrypted order

    mapping(address => uint256) public organiserNonce;
    mapping(address => bool)    public authorisedSponsors;

    function registerStore(bytes32 manifestRef) external returns (bytes32 storeId);
    function addProduct(bytes32 storeId, bytes32 productId, uint128 supply,
                        bytes32 manifestRef, uint64 flags) external;
    function updateProductManifest(bytes32 storeId, bytes32 productId,
                                   bytes32 newManifestRef) external; // metadata only
    function setProductActive(bytes32 storeId, bytes32 productId, bool active) external;

    function buyFor(bytes32 storeId, bytes32 productId, uint128 qty,
                    address buyer, bytes32 orderRef_) external onlyAuthorised
        returns (uint128 firstOrderSlot);
    function batchBuyFor(...) external onlyAuthorised;

    event StoreRegistered(bytes32 indexed storeId, address indexed organiser,
                          bytes32 manifestRef, bytes32[] tagHashes);
    event ProductAdded(bytes32 indexed storeId, bytes32 indexed productId,
                       uint128 supply, bytes32 manifestRef);
    event Purchase(bytes32 indexed storeId, bytes32 indexed productId,
                   address indexed buyer, uint128 firstOrderSlot, uint128 qty,
                   bytes32 orderRef);
}
```

### Why this shape

- **No per-store / per-product deployment.** `registerStore` and
  `addProduct` are single txs costing fractions of a cent on Arbitrum
- **Mutable metadata via `updateProductManifest`** — organisers can
  update photos, descriptions, prices without touching stock counters
- **Immutable supply** — once `addProduct` sets `supply`, it cannot
  increase (prevents organiser front-running buyers with stock dilution).
  To add more units of an existing product, add a new productId.
  Alternative: variable supply + event log so buyers can see history —
  decide during week 1
- **Indexed events for discovery** — `tagHashes` in `StoreRegistered`
  enables on-chain log indexing for tag-based search without expensive
  on-chain storage
- **`orderRef` per slot** — points to encrypted Swarm-stored order
  details (shipping address for physical, pickup time for food,
  preferences). Same SealedBox pattern as existing event order forms

### Tags / discovery

Tags are hashed off-chain (`keccak256("london")`, `keccak256("punk")`,
`keccak256("food/pizza")`) and emitted in `StoreRegistered` /
`ProductAdded` events. Indexers (anyone, not just us) read Arbitrum
logs and reconstruct the searchable directory. Same applies retroactively
to `WoCoEvent` — emit tags on `Registered` going forward.

This is the *honest* decentralised-discovery answer: the canonical
event log is the chain; multiple frontends can independently index it;
no platform-controlled feed required.

### Tasks

| # | Task | Effort |
|---|---|---|
| 1.1 | Write `WoCoStore.sol` + tests (Foundry) | 2 days |
| 1.2 | Deploy script for Arbitrum One + Sepolia | 0.5 day |
| 1.3 | Redeploy `WoCoEvent.sol` to Arbitrum One + Sepolia | 0.5 day |
| 1.4 | Server: `apps/server/src/lib/chain/store-contract.ts` mirroring `event-contract.ts` | 1 day |
| 1.5 | Server: `/api/stores/*` routes mirroring `/api/events/*` | 1.5 days |
| 1.6 | Server: extend sponsor wallet for store calls | 0.5 day |
| 1.7 | Chain config in `apps/web/src/lib/payment/chains.ts` for Arbitrum | 0.5 day |
| 1.8 | Stripe webhook → `buyFor` for paid store orders | 1 day |

Total: ~7.5 days. Split across two people: ~4 days elapsed.

---

## Workstream 2 — WoCo Wallet (the headline)

**Owner candidate**: extra dev #3 or you/me as primary; this is the
most novel piece and where pitch value concentrates.

### User flow

```
1. User visits any WoCo site → "Top up wallet" or "Pay with wallet"
2. Coinbase Smart Wallet popup (passkey, no seed phrase)
3. Wallet created → smart account address shown
4. Top up flow:
   a. Coinbase Pay onramp (~1% fee, fiat → USDC on Arbitrum)
   b. OR receive USDC from another wallet (free, just gas)
5. Balance shown in WoCo header / dashboard
6. Opt-in toggle: "Earn 4.2% APY on idle balance"
   → background sweep into Aave when balance > threshold
7. Spend: one-tap purchase, paymaster sponsors gas, USDC deducted
   from wallet (auto-withdrawn from Aave if needed)
```

### Why self-custodial is the only honest answer

- Custodial = money-transmitter licensing (FinCEN US, EMI EU,
  PSR UK) — months of legal work, capital reserves, KYC obligations
- Self-custodial = user's smart wallet, we provide UI only — no
  regulatory perimeter, ships in 3 weeks
- Aligns with WoCo's existing decentralisation principles (see
  `docs/CRYPTO_AUDIT_2026-04-08.md`)
- Coinbase Smart Wallet is built specifically for this: passkey UX,
  recoverable without seed phrase, free to create, ERC-4337 native

### Tech stack

- **Smart wallet**: Coinbase Smart Wallet SDK (`@coinbase/wallet-sdk`)
- **Onramp**: Coinbase Onramp SDK (or Stripe Crypto as fallback)
- **Paymaster**: Coinbase Paymaster on Arbitrum (free tier covers
  buildathon scale) OR self-hosted Pimlico paymaster
- **DeFi**: Aave V3 on Arbitrum — direct deposit/withdraw via SDK
- **Auth**: integrate as a new login method alongside existing
  Wallet/Local/Para options in `apps/web/src/lib/auth/`

### Gas economics (for the pitch)

> User holds $200 USDC. Aave V3 USDC supply APY on Arbitrum: ~4%
> (varies). Annual interest: ~$8. Average Arbitrum tx gas at current
> prices: ~$0.0005. Transactions per year covered by interest alone:
> ~16,000. The wallet pays its own gas. The user notices nothing.

Three-stage paymaster strategy:
1. **MVP (buildathon)**: we sponsor via Coinbase Paymaster — free tier
   covers demo volumes, ~$0.0005/tx if we exceed
2. **v1.5**: migrate to Circle's USDC paymaster — user pays gas in
   USDC (no ETH balance required), yield covers gas invisibly
3. **v2**: organiser-sponsored gas as a "premium" tier option — pubs
   that want zero-friction pints sponsor their patrons' gas, factor
   into the platform fee

### Tasks

| # | Task | Effort |
|---|---|---|
| 2.1 | Coinbase Smart Wallet integration as new auth method | 1.5 days |
| 2.2 | Wallet dashboard component (balance, top-up CTA, settings) | 1 day |
| 2.3 | Coinbase Onramp integration | 1 day |
| 2.4 | Aave V3 SDK integration on testnet | 1.5 days |
| 2.5 | "Pay with wallet" button across existing claim flows | 1 day |
| 2.6 | Paymaster wiring (Coinbase Paymaster, sponsor txs) | 1 day |
| 2.7 | Auto-withdraw from Aave when spend > liquid balance | 1 day |
| 2.8 | UI for opt-in yield toggle + APY display | 0.5 day |

Total: ~8.5 days. Single owner with help on auth integration.

---

## Workstream 3 — Stylus hot path

**Owner candidate**: extra dev #2 (Rust background ideal).

### What to port

Solidity stays as canonical reference. Stylus is the optimisation
layer for hot-path calls:

- `WoCoStore.buyFor` → `buy_for` in Rust
- `WoCoStore.batchBuyFor` → `batch_buy_for`
- `WoCoEvent.claimFor` → `claim_for`
- `WoCoEvent.batchClaimFor` → `batch_claim_for`

### Why these specifically

These are the throughput-critical paths. A successful drop hammers
them 100s of times per minute. The other contract methods
(`registerStore`, `addProduct`, `updateProductManifest`) are
organiser actions hit once per setup — Stylus offers nothing here.

### Approach

- Stylus contract deployed alongside Solidity reference; both
  implement the same interface
- Selector switch via a router contract OR deploy as separate addresses
  with chain config flag — decide during week 2
- Side-by-side benchmark:
  - Single `buy_for` Solidity vs Stylus
  - Batch of 50 Solidity vs Stylus
  - Worst-case Merkle verify Solidity vs Stylus
  - Cost delta in cents per claim, projected to a Glastonbury-scale
    drop (200k tickets in 90 minutes)

### Why this is real, not a checkbox

Stylus delivers genuine savings on hash-heavy and crypto-heavy code
(Merkle verify, EIP-191 sig verify). Our hot path has both. Benchmark
numbers in the pitch deck differentiate us from teams that "wrote
some Rust to tick a box."

### Tasks

| # | Task | Effort |
|---|---|---|
| 3.1 | Rust dev environment, Stylus SDK setup, deploy hello-world | 1 day |
| 3.2 | Port `buy_for` to Stylus | 2 days |
| 3.3 | Port `batch_buy_for` to Stylus | 1.5 days |
| 3.4 | Port `claim_for` + `batch_claim_for` to Stylus | 1.5 days |
| 3.5 | Side-by-side benchmark harness + scripts | 1 day |
| 3.6 | Benchmark report (cost projections, charts) for pitch | 0.5 day |
| 3.7 | Router or chain-config wiring for Stylus contracts | 1 day |

Total: ~8.5 days. Single dedicated owner.

---

## Workstream 4 — Agent surface

**Owner candidate**: you + me.

### Why this is small-scope

The endpoints already exist (`/api/payment/quote`,
`/api/reservations/reserve`, `/api/claim`, `/api/sites/:id/events-full`).
What's missing is:

1. Machine-readable spec (OpenAPI)
2. Discoverability (`.well-known/agent.json` per WoCo site)
3. MCP server wrapper (one file, exposes endpoints as MCP tools)
4. Agent-friendly delivery (skip email, deliver to wallet)
5. A demo agent that calls all the above

### Agent capabilities (v1)

- `discoverEvents(filters: { city?, tags?, dateRange?, priceRange? })` →
  list of events with prices in fiat + USDC
- `discoverStores(filters: { ... })` → list of stores + products
- `getQuote(eventId, qty)` → signed payment quote
- `reserveSlots(eventId, qty)` → reservation handle
- `buyTickets(reservationId, paymentTxHash | walletAuth)` → ticket POD
  delivered to specified address (or wallet)
- `buyProducts(...)` → same shape for store
- `getMyPurchases(walletAddress)` → on-chain query

### Demo agent flow (this is the pitch video)

> User opens WoCo wallet, types: "Find me three London punk gigs next
> month under £25 and buy a ticket to the cheapest."
>
> Agent calls `discoverEvents({ city: "London", tags: ["punk"],
> dateRange: { start: "2026-06-01", end: "2026-06-30" },
> priceRange: { max: 25 } })`. Filters results. Picks cheapest.
> Calls `getQuote`, `reserveSlots`, signs payment from user's wallet,
> calls `buyTickets`. Ticket POD appears in user's WoCo wallet.
>
> Elapsed time: ~20 seconds. Cost: ticket price + ~$0.0005 gas.

### Why this is "open standard" not "WoCo's API"

The spec, MCP definitions, and discovery format are published as a
standalone open-source repo (`woco-commerce-agent-spec`) under MIT.
Any commerce platform can implement the same surface; agents written
for WoCo work against any compliant platform.

The fundamental point: **the protocol is on-chain — it's already open
by definition**. Anyone can read the contracts, run their own indexer,
build a competing frontend. Nothing we do with licensing can close it.
So we shouldn't pretend otherwise — publish the spec MIT and let
network effects + execution differentiate us. The win is being the
canonical implementation, not gatekeeping.

Licensing posture across the codebase:
- **On-chain contracts + agent spec**: MIT (protocol-level, intrinsically open)
- **Frontend + backend application code**: AGPL (standard open-source
  commerce platform license — WooCommerce, Medusa, Saleor all use it.
  Forks must share improvements back; closed-source forking blocked.)
- **Actual differentiation**: network effects (merchants + buyers),
  execution speed, trust — never licensing.

### Tasks

| # | Task | Effort |
|---|---|---|
| 4.1 | OpenAPI spec for existing + new endpoints | 1 day |
| 4.2 | `/api/agent/*` routes (lightweight wrappers) | 1.5 days |
| 4.3 | `.well-known/agent.json` per deployed site (site-builder hook) | 0.5 day |
| 4.4 | MCP server (`apps/server/src/agent/mcp.ts`) | 1 day |
| 4.5 | Agent-friendly ticket delivery (wallet drop, skip email) | 1 day |
| 4.6 | Demo agent (TypeScript + LangChain OR Python + AgentKit) | 1.5 days |
| 4.7 | Demo video recording for pitch | 0.5 day |
| 4.8 | Publish spec as open-source repo | 0.5 day |

Total: ~7.5 days.

---

## Workstream 5 — Showcase site (vertical demos)

**Owner candidate**: rotating, whoever has bandwidth in week 3.

The pitch needs ONE site demonstrating multiple verticals on one
infrastructure. The Craufurd Arms is the chosen showcase venue.

### Three verticals on one site

1. **Tickets** — existing flow, now on Arbitrum, with wallet payment
2. **Merch store** — t-shirts, vinyl, posters — physical fulfilment
   with encrypted address capture
3. **Food order-ahead** — kitchen menu with shift queue (skip ahead
   for collection)

All three share:

- Same `WoCoStore` contract (or `WoCoEvent` for tickets)
- Same wallet payment flow
- Same agent API surface
- Same encrypted-order (SealedBox) pattern

### Why three verticals matter for the pitch

Demonstrates the *primitive* is general-purpose. Reviewer reaction:
"this isn't a ticketing app that bolted on merch — it's a commerce
protocol where ticketing is one instance." That's the difference
between a side project and infrastructure.

### Tasks

| # | Task | Effort |
|---|---|---|
| 5.1 | Store section types in MultiSiteBuilder (product grid, single product, cart) | 2 days |
| 5.2 | Order-ahead section type (kitchen menu, shift queue display) | 1.5 days |
| 5.3 | Wallet payment widget (drop-in, used across all three verticals) | 1 day |
| 5.4 | Showcase Craufurd Arms site — content, theme, deploy | 1 day |
| 5.5 | Polish demo flow for video recording | 0.5 day |

Total: ~6 days.

---

## Workstream 6 — Other Arbitrum-native tech

**Owner candidate**: shared / whoever has bandwidth in week 3.

Stylus has its own workstream (3). This covers the other Arbitrum
features we evaluated, what's in and out, and why.

### Timeboost — IN (small workstream)

Arbitrum's express-lane mechanism: bidders pay for priority block
inclusion. Genuine fit for hot ticket drops where MEV sandwiching
would ruin the buyer experience.

**Use case (real, not theoretical):** organiser releases 500 tickets
at 9am Friday. Without Timeboost, sophisticated buyers / bots can
sandwich legitimate buyers, jacking gas and grabbing inventory. With
Timeboost, the organiser (or the platform on their behalf) pays for
express-lane inclusion during the drop window — the first N seconds
of the sale, transactions are MEV-protected.

**Implementation shape:**

- Organiser opts into "priority drop" at event creation — optional
  flag in the event manifest
- Backend tracks drop start time + window (e.g. first 60 seconds)
- During the window, `claimFor` txs are submitted via the Timeboost
  express lane (paid bid by the WoCo sponsor wallet, billed back
  to the organiser through platform fee uplift)
- After the window, falls back to standard inclusion

**Honest scope:** Timeboost is still maturing; production integration
is non-trivial. The buildathon-feasible slice:

| # | Task | Effort |
|---|---|---|
| 6.1 | Research current Timeboost SDK + RPC interface | 0.5 day |
| 6.2 | Wire sponsor wallet to submit via express lane (testnet) | 1 day |
| 6.3 | "Priority drop" flag in event manifest + UI toggle | 0.5 day |
| 6.4 | Demo: timed drop with vs without Timeboost, MEV result comparison | 1 day |

Total: ~3 days. Targets week 3 alongside polish.

If the SDK isn't mature enough to integrate cleanly, this descopes
to a one-slide pitch section explaining the integration path —
still valuable because it demonstrates we understand the toolchain.

### Cross-chain USDC via CCTP — STRETCH

Circle's Cross-Chain Transfer Protocol — burn USDC on source chain,
mint on destination chain. Native, not bridged, no wrapped token
risk. Live on Arbitrum, Base, Optimism, Mainnet, and others.

**Use case:** buyer has USDC on Base (or any supported chain).
WoCo Wallet is on Arbitrum. Today they'd need to bridge manually.
With CCTP integration, the wallet absorbs the chain difference —
buyer clicks "Pay with USDC," we route the burn-and-mint, ticket
appears in their wallet on Arbitrum.

**Why stretch, not in:** the WoCo Wallet workstream (2) already
gives users an Arbitrum-native USDC balance via Coinbase Onramp,
which is the simpler path for the buildathon demo. CCTP becomes
genuinely useful at scale when buyers have USDC scattered across
chains — not in week-3 of a buildathon.

**Buildathon-feasible slice (if time allows):**

| # | Task | Effort |
|---|---|---|
| 6.5 | CCTP SDK integration on Base ↔ Arbitrum testnet pair | 1 day |
| 6.6 | "Pay from Base USDC" option in wallet checkout | 0.5 day |
| 6.7 | Demo: pay from Base, ticket on Arbitrum | 0.5 day |

Total: ~2 days. Targets late week 3 if Stylus + Timeboost have shipped.

### WASM-native financial tooling — OUT

Mentioned by Arbitrum as a bonus area; nothing in WoCo's domain
maps cleanly to it. Pretending to use it would be tick-box
behaviour. We're already shipping WASM via Stylus (workstream 3)
— that's the genuine use.

### Orbit chain — OUT

Spinning up a custom Orbit chain for WoCo is multi-quarter work
(sequencer, RPC, indexer infra, bridge config) with no buildathon
upside. Arbitrum One is the right venue for the pitch — it's where
the liquidity and the wallets are. Worth revisiting post-buildathon
if WoCo grows to multi-million-tx scale where dedicated chain
economics make sense.

### Stylus — see Workstream 3

Full treatment in its own section above.

### Pitch positioning of native-tech use

In the deck and demo video:

- **Stylus** — quantified benchmark chart, hard numbers
- **Timeboost** — narrative + live drop demo if shipped, integration
  path slide if not
- **CCTP** — bonus slide if shipped, otherwise mentioned in roadmap
- **Arbitrum One mainnet deploy** — table-stakes, mentioned in passing

Three real native-tech uses (Stylus + Timeboost + CCTP) shipped well
beats five mentioned superficially. The pitch should make clear we
*chose* not to chase Orbit / WASM-tooling because those aren't honest
fits — that signals technical judgement to the judges, which is
itself a positive signal.

---

## Three-week schedule

Aggressive but doable with 3 extra devs. Achievable with 1 extra dev
if Stylus is descoped to a stretch. Solo (no extra devs) requires
descoping Stylus *and* food order-ahead.

### Week 1 (May 25 — May 31)

| Day | Workstream | Milestone |
|---|---|---|
| Mon | All | Buildathon kickoff + speed-dating + team formation |
| Tue | 1.1, 1.2 | `WoCoStore.sol` skeleton + tests; deploy script ready |
| Wed | 1.3, 1.4, 2.1 | Arbitrum deploys live; wallet auth method scaffolded |
| Thu | 1.5, 2.2, 3.1 | Server `/api/stores/*` routes; wallet dashboard; Stylus env up |
| Fri | 1.6, 2.3, 3.2 | Sponsor wallet store integration; onramp working; first Stylus port |
| Sat | 4.1, 4.2 | OpenAPI spec; agent routes wrapped |
| Sun | 5.1 | Store section types in builder UI |

**End-of-week-1 checkpoint**: contracts live on Arbitrum Sepolia,
wallet creates + tops up, store has a working buy flow on testnet.

### Week 2 (Jun 1 — Jun 7)

| Day | Workstream | Milestone |
|---|---|---|
| Mon | 2.4, 2.6, 3.3 | Aave integration; paymaster wiring; Stylus batch port |
| Tue | 2.5, 4.4, 5.2 | Wallet payment button live; MCP server; food order-ahead UI |
| Wed | 1.7, 1.8, 2.7 | Arbitrum chain config; Stripe → store webhook; Aave auto-withdraw |
| Thu | 3.4, 4.3, 4.5 | Stylus event-side port; agent.json; wallet-drop delivery |
| Fri | 2.8, 5.3, 4.6 | APY UI; wallet payment widget; demo agent scripting |
| Sat | 3.5, 5.4 | Stylus benchmark harness; Craufurd Arms site content |
| Sun | All | Integration testing across all four workstreams |

**End-of-week-2 checkpoint**: full vertical flow works on Arbitrum
Sepolia — discover via agent, reserve, pay from wallet, get ticket
delivered to wallet. Stylus benchmarks ready.

### Week 3 (Jun 8 — Jun 14)

| Day | Workstream | Milestone |
|---|---|---|
| Mon | Mainnet | Deploy contracts to Arbitrum One mainnet |
| Tue | Production migration | Wallet works on mainnet, Coinbase Paymaster live |
| Wed | 4.7, 4.8, 3.6 | Demo agent video; open-source spec publish; Stylus report |
| Thu | 5.5, Polish | Demo site polish; bug bash |
| Fri | Stretch | Timeboost research + integration attempt OR CCTP cross-chain |
| Sat | Pitch | Pitch deck, judging materials, submission package |
| Sun | Buffer | Final polish, contingency |

**End-of-week-3**: submitted.

---

## Demo / pitch script

Two-minute video, three acts:

### Act 1 (0:00–0:40) — the primitive

Show the Craufurd Arms site. Click "Buy ticket" — pay from wallet,
gasless, instant. Click "Buy t-shirt" — same wallet, same flow, ships
to encrypted address. Click "Order pint + burger for collection" —
same wallet, joins kitchen queue, notification when ready.

Voiceover: "One contract on Arbitrum powers all three. Ticketing,
merch, food, bookings — same primitive, infinite verticals."

### Act 2 (0:40–1:20) — the wallet

Show wallet dashboard. Balance: $187 USDC. Earning 4.2% APY. Top-up
flow via Coinbase Pay. Show transfer to a friend's wallet — free,
instant. Voiceover: "Your spending account. Pays you interest. Your
keys, your funds. Built on Arbitrum because that's where USDC, DeFi,
and sub-cent gas all live."

### Act 3 (1:20–2:00) — the agent

Open Claude / GPT / custom agent. Type: "Find me three London punk
gigs next month under £25 and buy a ticket to the cheapest."
Agent finds, picks, pays from wallet, ticket appears in wallet.

Voiceover: "Open standard for AI agents to transact on WoCo. The
canonical implementation now — and what every commerce platform
will look like in three years."

Close on Stylus benchmark chart: "Built Arbitrum-native. Stylus
hot path delivers X% gas reduction at scale."

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Stylus learning curve eats two weeks | Med | High | Descope to stretch if Rust dev not on team by end of day 1 |
| Coinbase Smart Wallet quirks on Arbitrum | Med | Med | Have Pimlico as fallback paymaster provider |
| Aave testnet flaky / wrong APY | Low | Low | UI shows mainnet APY as static; opt-in toggle non-functional in demo if needed |
| Speed-dating yields zero devs | Med | High | Plan still works solo if Stylus + food order-ahead descoped |
| Stripe webhook → store flow has new edge cases | Med | Med | Existing event flow is well-tested template; mirror exactly |
| Demo video recording goes wrong | Low | High | Record twice, day before submission |
| Arbitrum mainnet bridge / RPC issues | Low | Med | Sepolia demo as fallback; mention "mainnet deploy live at <address>" |
| Pitch overruns 2 minutes | Med | Low | Cut Stylus benchmark to a single number if needed |

---

## Open questions to resolve in week 1

- **Stylus vs Solidity routing**: separate addresses with chain-config
  flag, or router contract? Decide by Wed week 1.
- **Mutable vs immutable product supply**: how do organisers add stock
  honestly without front-running buyers? Probably: emit a `SupplyAdded`
  event and require N-block notice. Decide by Thu week 1.
- **Order form for store**: reuse event SealedBox pattern verbatim, or
  refactor into shared `packages/shared/src/order/` module? Probably
  shared module. Decide during 1.5.
- **Agent demo language**: TypeScript + LangChain (matches codebase) or
  Python + AgentKit (closer to crypto agent ecosystem)? Probably
  TypeScript for repo cohesion. Decide by week 2.
- **Showcase site**: real Craufurd Arms approach (with their content)
  or fictional venue we control? Probably fictional pub for safety
  (no dependency on their sign-off). Decide by Sat week 2.

---

## Post-buildathon (roadmap slide)

What we ship in 3 weeks is genuine v1. What it unlocks:

- **Production Aave routing** — security audit, fee-share model with
  organisers, organiser-sponsored yield as a loyalty programme
- **Circle USDC paymaster migration** — off WoCo-sponsored gas, onto
  yield-covered gas — invisible to user, zero cost to us
- **More verticals** — bookings, hire-out, queues, classes,
  subscriptions — each is a `manifestRef` schema and a builder template
- **Cross-chain liquidity** — accept USDC on any chain, settle on
  Arbitrum via CCTP — buyers don't care which chain their USDC is on
- **Mobile-first PWA** — tap-to-pay for the pub, NFC for ticket scan,
  passkey for everything
- **Organiser yield-share** — venues earn a cut of the yield generated
  by their patrons' balances — flip the loyalty programme on its head

The pitch is not "we built X in three weeks." The pitch is "we built
the v1 of decentralised commerce infrastructure for the real world,
on Arbitrum. Here's the roadmap. Here's why the chain choice matters.
Here's the open standard we're publishing."

---

## Submission package

- Live demo URL (Arbitrum One mainnet)
- GitHub repo (this monorepo + the open-source agent spec repo)
- Pitch deck (10 slides max)
- Demo video (2 min)
- Stylus benchmark report (1-pager)
- Open standard spec repo (MIT-licensed)
- Founder House application materials if shortlisted

---

## File map (planned changes / additions)

### New contracts

```
contracts/src/WoCoStore.sol
contracts/src/stylus/                       (new dir)
contracts/src/stylus/Cargo.toml
contracts/src/stylus/woco-store/lib.rs
contracts/src/stylus/woco-event/lib.rs
contracts/script/DeployStore.s.sol
contracts/script/DeployArbitrum.s.sol
contracts/script/BenchmarkStylusVsSolidity.s.sol
contracts/test/WoCoStore.t.sol
```

### Server additions

```
apps/server/src/routes/stores.ts                  (mirror of events.ts)
apps/server/src/routes/agent.ts                   (lightweight wrappers + MCP-compatible)
apps/server/src/lib/chain/store-contract.ts       (mirror of event-contract.ts)
apps/server/src/lib/chain/sponsor-wallet.ts       (extend for store calls)
apps/server/src/agent/mcp.ts                      (MCP server)
apps/server/src/agent/openapi.ts                  (generate spec from routes)
apps/server/src/lib/wallet/                       (new dir — smart-wallet helpers)
```

### Web additions

```
apps/web/src/lib/wallet/                          (new dir — WoCo Wallet)
apps/web/src/lib/wallet/smart-wallet.ts
apps/web/src/lib/wallet/onramp.ts
apps/web/src/lib/wallet/aave.ts
apps/web/src/lib/wallet/paymaster.ts
apps/web/src/lib/auth/smart-wallet-account.ts     (new auth method)
apps/web/src/lib/components/wallet/WalletDashboard.svelte
apps/web/src/lib/components/wallet/TopUpModal.svelte
apps/web/src/lib/components/wallet/PayWithWalletButton.svelte
apps/web/src/lib/components/wallet/YieldToggle.svelte
apps/web/src/lib/components/store/ProductGridSection.svelte
apps/web/src/lib/components/store/SingleProductSection.svelte
apps/web/src/lib/components/store/CartDrawer.svelte
apps/web/src/lib/components/store/OrderAheadSection.svelte
apps/web/src/lib/api/store.ts
apps/web/src/lib/api/wallet.ts
```

### Shared additions

```
packages/shared/src/store/types.ts
packages/shared/src/store/topics.ts                (Swarm topics for store metadata)
packages/shared/src/order/sealed-box.ts            (shared between events + store)
```

### Open-source spec repo (separate)

```
woco-commerce-agent-spec/
  openapi.yaml
  mcp-tools.json
  well-known-template.json
  README.md
  examples/typescript-langchain/
  examples/python-agentkit/
```

---

## Why this submission wins (or at least Founder Houses)

- **Real infrastructure, not a hackathon toy** — it's v1 of something
  that becomes a multi-quarter product
- **Compounds on existing live system** — judges can see we're not
  starting from zero; the contract pattern, payment flow, and site
  builder all exist
- **Three Arbitrum-native angles** done well, not five done
  superficially — USDC + Stylus + paymaster ecosystem
- **Open standard play** — the agent surface published as MIT is
  exactly the "ecosystem-building" energy the Founder House
  programme rewards
- **Demoable in 2 minutes** — three verticals, one wallet, one agent.
  Easy to grok, hard to forget
- **Cleanly self-custodial** — no regulatory hand-waving, no future
  KYC pivot, no money-transmitter exposure
- **Genuinely matches their narrative** — "infrastructure trusted by
  institutions, used by millions" is what BlackRock + Robinhood needed;
  this is what the high street needs
