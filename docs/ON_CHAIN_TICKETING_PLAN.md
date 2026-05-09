# On-Chain Ticketing Migration Plan

Context dump for a new chat. Resume design/implementation discussion from here.
Date: 2026-05-08. Revised 2026-05-09.

## TL;DR

Migrating WoCo ticketing to a small on-chain queue contract on **Base mainnet**
(Sepolia for staging), with pre-signed PODs at event creation. Resolves three
problems:

1. **Throughput**: today ~15 claims/min/series; chain handles arbitrary load.
2. **Trust**: today the platform signer owns every Swarm feed; new model
   retires it from the *ticketing* path entirely (collection/profile/avatar
   feeds remain platform-signed in v1 — see scope below).
3. **Uniqueness**: chain `nextSlot++` is atomic; oversell impossible.
   Off-chain reservation (existing pattern) handles the UI soft hold;
   chain only fires when real money is committed (Stripe webhook or
   `payAndClaim`). No gas is spent on un-committed buyer intent — closes
   the griefing vector that an on-chain reserve would expose.

**v1 is Stripe-only and email-delivery-only.**
- Crypto payment path (`payAndClaim`) is deferred to v1.5; the contract
  supports it from day one but no frontend integration in v1.
- **No buyer collection-feed writes in v1.** The ticket POD is delivered
  by email. The buyer's `woco/pod/collection/{burner}` feed is NOT
  written. That migration ships in v1.5+ alongside crypto payments.
- **Platform feed signer is retained** for everything we don't explicitly
  migrate (collection, profile, avatar, discovery directory). Organiser-
  owned feeds (event metadata, site config, creator directory) are already
  signed organiser-side via session delegation today and stay that way.
  The only feed-signing change in v1 is what the organiser does at event
  creation (pre-sign N PODs / sign the issuance manifest).

Long-term goal: phase out the backend's role to the minimum required by
centralised dependencies (Stripe webhooks, email send). The backend signs
nothing on the buyer's behalf for ticketing; users will own their own keys
for collection feeds in v1.5+.

## Chain choice — Base mainnet

| | Base | Gnosis | Mainnet |
|---|---|---|---|
| Per-claim gas | ~$0.005 | ~$0.0001 | ~$2–5 |
| USDC native | Yes (Circle-issued) | Bridged | Yes |
| Smart account / 4337 ecosystem | First-class | Sparse | Mature but expensive |
| Wallet defaults (Coinbase Smart Wallet, Para, MetaMask) | Native | Manual chain add | Native |
| Already wired in our payment verify code | **Yes** | No | Yes |

At expected volumes, the gas gap between Base and Gnosis is meaningless
inside Stripe's 1.5–2% card fee. What Base buys: USDC native, every wallet
works out of the box, Coinbase Smart Wallet for free passkey-only UX,
existing chain plumbing in `apps/server/src/lib/payment/verify.ts`. Gnosis
wins on decentralisation purity but loses on the UX axes that matter for
paid tickets.

**Decision: Base mainnet for production, Base Sepolia for staging.**

### Backup chain plan

Two distinct roles — they're complementary, not alternatives:

**v1 failover: Optimism mainnet.** Same OP-stack as Base, so
`WoCoEvent.sol` redeploys with zero source changes. UX unchanged (same
wallets, same Circle-native USDC, same gas math). Switching is two env
vars + a redeploy. Treat it as zero-cost insurance:
- Keep the deploy script wired for Optimism mainnet from day one
  (`contracts/script/DeployEvent.s.sol` outputs OP addresses too)
- Don't deploy to OP unless Base has a real outage — but having the
  script ready means the swap window is hours, not days
- Optimism Sepolia for failover staging tests

**v2 expansion: Gnosis chain.** Genuine second-chain offering, not a
failover. Justified by:
- We already provision a Gnosis RPC because the Bee node uses Gnosis
  for postage stamp top-ups — operational cost is near-zero to add
- Validator-decentralised L1 (not another rollup downstream of
  Ethereum) — real diversification, aligns with the project's civic /
  decentralised ethos
- Predictable xDAI-denominated gas (~$0.0001/claim, effectively free)
- Could let organisers pick Gnosis for civic / community-funded events
  and Base for mainstream events — chain choice as a positioning lever

What Gnosis requires that Optimism doesn't:
- New chain ID + wallet config in `apps/web/src/lib/payment/chains.ts`
- Bridged USDC contract address (Gnosis's USDC is bridged, not
  Circle-native) — affects `payAndClaim` for v1.5+ but not v1's
  Stripe-only path
- Separate oracle price feed config in `apps/server/src/lib/payment/`
- Reuse Bee's existing Gnosis RPC URL (already in `apps/server/.env`
  via Bee config) — no new infrastructure to provision

Out of scope for v1 — the contract code is identical, but the wallet/
oracle/USDC plumbing is real work. Defer to v2 once organiser demand
justifies it.

## App split — three sub-ENS apps

Once Pattern A is live, split the monorepo into three deployable apps,
each at its own ENS subname → its own Swarm BZZ collection:

```
woco.eth.limo      → consumer (discover, buy, MyTickets)         [today]
toolbox.woco.eth   → organiser (event create, site builder,
                     dashboard, Stripe Connect, scanner config)
scan.woco.eth      → door scanner PWA (offline, organiser-only)
```

**Build shape:** separate Vite entrypoints in the same monorepo, each
producing its own `dist-*` and its own BZZ deploy. Share `packages/shared`
(types, POD verify, chain client) and extract a thin `packages/ui` for
theme tokens + a few primitives.

Why three separate builds, not one app with hostname routing:
- Scanner must work fully offline (service worker + cached POD manifest).
  One bundle means scanner ships consumer + organiser code it never uses.
- Auth surface differs: consumer = email/passkey/wallet; organiser =
  wallet-only; scanner = organiser-key + device-bound passkey. Smaller
  blast radius if one is compromised.
- Audit story is cleaner — each app's threat model is self-contained.
- Independent release cadence: organiser tooling iterates faster than
  the scanner needs to.

Most code is already organised by directory (`components/builder/`,
`components/dashboard/`, etc.) — split is mostly Vite config + package
exports, not a rewrite.

## Core architectural model

Three layers, separated by job:

- **Chain (Base)**: ordering authority. Stores per-event `nextSlot` counter
  and `slotOwner[eventId][slot]` map. Enforces uniqueness atomically.
- **Swarm**: ticket data store. Holds organiser-signed PODs (created at
  event creation) and user-owned collection feeds.
- **Organiser ed25519 signature**: ticket authenticity anchor. Signs the
  POD at event creation. Same key as today.

Verifier at the door checks both: organiser ed25519 signature on the POD,
**and** `slotOwner[eventId][slot]` on chain matches the claimer.

## What stays the same

- PODs are still organiser-ed25519-signed on Swarm.
- Stripe Connect flow unchanged for the buyer (still pays by card).
- Per-event ticket pages, composite PNG, email delivery — unchanged shape.
- Auth (EIP-712 / session delegation) — unchanged.
- Reservation TTL pattern — unchanged shape, new home (on-chain).

## What changes

- **PODs created and uploaded to Swarm at event creation, not at claim
  time.** Organiser signs N PODs upfront with edition numbers 1..N. PODs
  contain ticket metadata only — no claimer field. Ownership is the chain
  record, not part of the POD.
- **Slot ordering moves to Solidity contract on Base.** Atomic, BFT,
  oversell-impossible.
- **Editions / claims / claimers / pending-claims feeds become redundant.**
  The chain is canonical for ownership; the per-event POD manifest (Swarm)
  is canonical for ticket data.
- **User-owned feeds (`collection`, `profile`, `avatar`) — NO change in v1.**
  Stay platform-signed. Migration to client-side signing ships in v1.5+
  alongside crypto payments and the buyer collection-feed write.
- **Organiser-owned feeds (event metadata, site config, creator directory)
  — already organiser-signed today via session delegation. No change.**
- **Reservations stay off-chain** (existing `reservation-store.ts`). On-chain
  state is only touched when money is committed (webhook / `payAndClaim`).
  Prevents gas-griefing on unauthenticated "Pay" clicks.
- **Burner wallet pattern (client-side keygen)**: each Stripe/email buyer's
  browser generates a fresh secp256k1 keypair when they fill the order
  form. Only the **public address** is sent to the backend — the private
  key never crosses the network. Stored in browser localStorage. The
  email contains the ticket only; **no private key is ever emailed**.
  Key is **fully dormant in v1** (no buyer-callable contract functions,
  no buyer-signed feed writes) and becomes load-bearing only when the
  buyer chooses to upgrade to a stable WoCo account in v1.5+.

  **Keypair-ownership proof at checkout (security fix):** the client signs
  `woco-burner-v1:{eventId}:{nonce}:{email}` with the burner privkey and
  submits the signature alongside the pubkey to `/create-checkout`. Backend
  verifies. Without this, an attacker could submit *their own* pubkey while
  the legitimate buyer pays via Stripe — the ticket would bind on chain
  to the attacker's address. Dormant impact in v1 (no buyer-callable
  functions yet) but it bites at v1.5, so wire it from day one.

After migration, the platform signer has **no remaining job** for ticketing.

## Pre-signed POD model

### At event creation (organiser online)

**v1 uses the Merkle issuance manifest pattern for all events.** No
`totalSupply` cap. Single signed manifest scales from 10 tickets to
50,000+ with the same code path. We rejected the simpler "sign N PODs
individually" approach because we'd need to migrate off it within
months — same code written twice plus a dual-support flag forever.

Flow:

1. Organiser sets `totalSupply = N` and ticket metadata.
2. Frontend generates N POD records (no signatures), edition numbers
   1..N, no `claimedBy` field.
3. Frontend computes the leaf for each edition:
   `leaf_n = keccak256(0x00 || u32_be(n) || canonicalBytes(POD_n))`
4. Frontend builds a Merkle tree using `@openzeppelin/merkle-tree` (the
   audited canonical JS impl — RFC 6962 domain separation, duplicate-
   last-leaf padding for non-power-of-2 counts).
5. Organiser ed25519-signs **one** manifest:
   ```json
   {
     "format": "woco.manifest.v1",
     "eventId": "...",
     "totalSupply": N,
     "issuerPubkey": "...",
     "metadataRoot": "0x...",
     "encoding": "cbor-v1",
     "padding": "duplicate-last",
     "podTemplate": { ...shared metadata... }
   }
   ```
6. Manifest + the full leaf set + per-edition POD bodies upload to
   Swarm as a Mantaray collection → single immutable content ref
   (`manifestRef`).
7. Organiser registers the event on chain:
   `registerEvent(N, manifestRef)`. `eventId` is derived inside the
   contract from `keccak256(msg.sender, organiserNonce++)` so an
   attacker cannot front-run with a colliding eventId.

Single ed25519 sig at creation. Browser cost is O(1) signing + O(N)
keccak hashing — even at N=50,000 the tree builds in under a second.

### Manifest pattern — locked-in cryptographic specification

These choices ship in v1 and become permanent commitments. Document
them in `packages/shared/src/pod/canonical.ts` with test vectors before
writing the tree builder.

**Canonical POD encoding: DAG-CBOR** (RFC 8949 deterministic encoding).
Picked over JSON because:
- JSON canonicalisation has too many footguns (number representation,
  Unicode normalisation, key ordering).
- CBOR is already in use across the Swarm/IPLD ecosystem.
- `@ipld/dag-cbor` is well-maintained and round-trip-safe in browsers
  and Node.

**Leaf format:**
```
leaf_n = keccak256(
  0x00 ||                         // domain separator: leaf
  u32_be(edition) ||              // 4 bytes — binds edition into leaf
  dagCbor(POD_n_canonical)        // POD body
)
```
Edition is bound into the leaf so an attacker cannot swap proofs
between editions even if PODs share metadata.

**Internal node format:** `keccak256(0x01 || left || right)` (RFC 6962
domain separation). Provided by `@openzeppelin/merkle-tree` if we use
`StandardMerkleTree.of(leaves, ['bytes32'])`.

**Padding:** duplicate-last-leaf for non-power-of-2 counts (OZ standard).

**Manifest signature:** ed25519 over `keccak256(dagCbor(manifest))`.
Reuses the existing organiser ed25519 key from `pod-identity.ts`.

**Verifier responsibilities (door scanner, fully offline):**
1. Verify manifest ed25519 sig against issuerPubkey.
2. Verify chain `events[eventId].manifestRef == hash(manifest)` —
   i.e. the manifest matches what the organiser registered on chain
   (cached pre-event from a chain snapshot, refreshed when online).
3. Verify Merkle proof for the scanned edition reaches `metadataRoot`.
4. Verify chain `slotOwner[eventId][slot] == burnerPubkey` for the
   scanned ticket (also from cached chain snapshot).

**No on-chain Merkle verification in v1.** The contract just stores
`manifestRef` and `slotOwner`. All proof verification is browser-side
or scanner-side. This keeps the contract minimal and removes the
canonicalisation cross-language hazard — we control both producer and
consumer in JS.

QR payload stays compact: `{eventId, slot, sig}` only. Scanner has the
cached leaf set + manifest, computes the proof on-device. No QR bloat.

### Why this pattern is safe to lock in

Merkle distribution is one of the most battle-tested primitives in the
Ethereum ecosystem (every major token airdrop uses
`@openzeppelin/merkle-tree`). The cryptographic surface is:
- 1 audited dependency (`@openzeppelin/merkle-tree`)
- 1 audited canonical encoder (`@ipld/dag-cbor`)
- ~50 LOC of glue defining the leaf format + manifest schema

Test vectors covering: edition-swap attempts (rejected), tampered POD
bodies (rejected), tampered manifest (rejected because chain
`manifestRef` no longer matches), non-power-of-2 supplies (proofs
verify), edge supply counts (1, 2, 1000, 50000).

After event creation, **the entire ticket inventory is on Swarm and
ready**. No claim-time signing or uploading. Claims become pure
ownership-assignment operations.

### POD content (no claimer field)

```json
{
  "format": "woco.ticket.v2",
  "eventId": "...",
  "seriesId": "...",
  "edition": 47,
  "metadata": { "name": "...", "image": "...", ... },
  "issuer": "0x...organiserPubkey",
  "signature": "ed25519..."
}
```

The `claimedBy` field that exists today on `woco.ticket.claimed.v1` PODs is
**removed**. Ownership is queried from chain (`slotOwner[eventId][slot]`),
not stored in the POD. This decouples the immutable ticket from its
mutable owner — enables pre-creation, future transferability, no re-signing
on ownership change.

## Per-claim data: where email + form fields live

The POD is pure ticket data and is never modified. Buyer-specific data
(email, name, order form fields) lives in a **separate encrypted-order
SealedBox**, encrypted to the organiser's POD pubkey.

**The encrypted order ref is carried by the chain event itself** — no
per-event claims feed, no writer key, no central signer.

Updated `SlotClaimed` event:
```solidity
event SlotClaimed(bytes32 indexed eventId, uint256 slot, address indexed buyer, bytes32 orderRef);
```

The 32-byte `orderRef` field adds ~256 gas per claim. Negligible. The
chain's event log is the claims index — free to read, indexable by
`eventId`, chain-strength permanent.

Four distinct stores per claim, no central writer key for any of them:

| Data | Storage | Signed by | Visibility |
|---|---|---|---|
| POD (ticket content) | Swarm | Organiser ed25519 (at event creation) | Public |
| Slot ownership + orderRef | Chain `slotOwner` + `SlotClaimed` event | Buyer's tx (crypto) or sponsor (Stripe, pays gas only) | Public |
| Encrypted order (email, name, form) | Swarm SealedBox | **Nobody** — content-addressed upload, anyone can upload | Encrypted to organiser pubkey |
| Buyer's collection feed | Swarm feed `woco/pod/collection/{burner}` | Burner key (client-side) | Public |

### Dashboard attendee reconstruction

To show "edition 47 → alice@example.com" the dashboard:
1. Queries chain for `SlotClaimed` events filtered by `eventId`. Gets list
   of `{slot, buyer, orderRef}`.
2. For each entry: fetches the encrypted SealedBox from Swarm by `orderRef`.
3. Decrypts with the organiser's POD key (already happens client-side
   in today's dashboard).
4. Renders attendee row.

No Swarm feed walk. No writer key. The chain is the index.

### At claim time

**Crypto buyer (v1.5)** — fully client-driven, backend not involved:
1. Browser encrypts order data to organiser pubkey → SealedBox.
2. Browser uploads SealedBox to Swarm → `orderRef`. Postage stamp from
   platform via a public stamp-relay endpoint (not a signer; just relays).
3. Browser calls `payAndClaim(eventId, orderRef)` with payment.
4. Contract emits `SlotClaimed(eventId, slot, buyer, orderRef)`.
5. Browser signs own collection feed update.

**Stripe buyer (v1)** — client-side keygen, backend never sees private key:
1. **Browser** generates burner secp256k1 keypair on order-form submit.
   Privkey stored in localStorage. Pubkey + a signature over
   `woco-burner-v1:{eventId}:{nonce}:{email}` sent to backend (proves
   keypair ownership — closes the front-run substitution attack).
2. Browser encrypts order data to organiser pubkey → SealedBox, uploads
   to Swarm via platform postage-stamp relay → `orderRef`. (Backend can
   alternatively do this if email-only flow needs it; either way no
   signing key required for upload — content-addressed.)
3. Backend verifies the keypair-ownership signature, stashes
   `{burnerPubkey, eventId, orderRef, nonce}` against the Stripe
   `session_id`. **No private key stored anywhere on backend.**
4. After payment: backend calls `claimFor(eventId, burnerPubkey, orderRef)`
   from sponsor wallet (pays gas only).
5. Contract emits `SlotClaimed(eventId, slot, burnerPubkey, orderRef)`.
6. **v1 STOP HERE.** Backend looks up the POD ref for the allocated slot
   and emails the ticket. Buyer's collection feed is NOT written.
7. (v1.5+) Buyer returns to success page → browser reads privkey from
   localStorage → signs the buyer's own collection feed update directly.
   Backend not involved in this signing. **Out of scope for v1.**

### What the platform holds, in total

| Key | Purpose | Persistence |
|---|---|---|
| Sponsor wallet (secp256k1) | Pays chain gas for Stripe/email claims | Persistent |
| Postage stamp | Pays Swarm storage for buyer-uploaded orders (relay) | Persistent |

**No buyer private keys ever touch the backend.** Burner keys are generated
in the browser and stored only in the buyer's localStorage. The platform
pays gas and Swarm postage; it does not sign anything that grants
ownership, attests to organiser data, or proves buyer identity.

## Pattern A contract surface (Stripe-only v1)

One shared contract on Base. ~100 LOC. New contract; **separate** from
`WoCoEscrow.sol` — escrow holds value, this one doesn't, so don't combine
them. Non-upgradable. If a v2 is needed, deploy fresh and let v1 events
drain on the old contract.

```solidity
contract WoCoEvent {
  struct Event {
    uint256 totalSupply;
    uint256 nextSlot;
    address organiser;
    bytes32 manifestRef;       // Swarm Mantaray collection ref
  }

  mapping(bytes32 => Event) public events;
  mapping(bytes32 => mapping(uint256 => address)) public slotOwner;
  mapping(address => bool) public authorisedSponsors;
  mapping(address => uint256) public organiserNonce;

  event Registered(bytes32 indexed eventId, address indexed organiser,
                   uint256 supply, bytes32 manifestRef);
  event SlotClaimed(bytes32 indexed eventId, uint256 slot,
                    address indexed buyer, bytes32 orderRef);

  // eventId derived inside the contract — caller cannot specify it,
  // closing the front-run / collision attack. Organiser is always msg.sender.
  function registerEvent(uint256 supply, bytes32 manifestRef)
    external returns (bytes32 eventId);

  function claimFor(bytes32 eventId, address burner, bytes32 orderRef)
    external onlyAuthorised returns (uint256 slot);

  // Admin (2-of-N multisig owner)
  function addSponsor(address sponsor) external onlyOwner;
  function removeSponsor(address sponsor) external onlyOwner;

  // Crypto path — deferred to v1.5 (no payable functions in v1)
  // function payAndClaim(bytes32 eventId, bytes32 orderRef) external payable returns (uint256 slot);
}
```

**Contract-level security choices:**

- `eventId = keccak256(abi.encode(msg.sender, organiserNonce[msg.sender]++))`
  — caller cannot specify or front-run. Organiser is always `msg.sender`.
- `slotOwner` is the canonical ownership record. Door scanner reads this.
- `authorisedSponsors` is a set, behind a multisig owner. Sponsor key
  rotation is a single tx, no redeploy.
- No `payable` functions in v1 → contract holds no value → audit pressure
  is low. Slither + Foundry fuzz tests + peer review is sufficient. Revisit
  formal audit when `payAndClaim` ships in v1.5.

No reservations on chain. `claimFor` is the only state-changing call on
the hot path: it atomically increments `nextSlot`, records
`slotOwner[eventId][slot] = burner`, and emits `SlotClaimed`. Reverts on
oversell.

`onlyAuthorised` = caller is in `authorisedSponsors` set. Initially just
the platform's sponsor wallet. Organisers can opt to run their own sponsor
wallet later.

### Why no on-chain reservation

An on-chain `reserve()` called on every "Pay" click would let an attacker
script millions of clicks and drain sponsor wallet gas with no payment.
Off-chain reservation (existing `reservation-store.ts`) handles the soft
hold + countdown UI; the chain is only touched when money is committed.

The race "two buyers get past the off-chain hold for the same slot" is
caught by the contract: one `claimFor` succeeds, the other reverts (no
oversell possible). Backend auto-refunds the loser via existing
partial-refund logic. Same failure shape as today's reservation system,
with chain-strength uniqueness at the final step.

### Gas profile (Base mainnet)

| Action | Who pays | Cost | Frequency |
|---|---|---|---|
| Contract deploy | Platform | ~$1 | Once ever |
| Event register | Organiser or platform | ~$0.01 | Per event |
| Stripe claim | Platform sponsor | ~$0.005 | Per ticket sold (webhook) |
| Free claim | Platform sponsor | ~$0.005 | Per free RSVP |

For 100 paid tickets: ~$0.51 in gas total across all parties. Negligible
inside Stripe's 2% card fee. Crucially, gas is only spent when a buyer
has actually committed money (Stripe webhook) or paid on chain
(`payAndClaim`) — not on UI "Pay" clicks.

## Stripe-only v1 buyer flow (full)

1. Buyer fills the order form (email + form fields). On submit:
   - **Browser** generates a fresh secp256k1 burner keypair (`viem` /
     `@noble/secp256k1`).
   - Privkey stored in localStorage, optionally wrapped with a key
     derived from the email entered (PBKDF2 → AES-GCM, at-rest only).
   - Browser encrypts order data → SealedBox, uploads to Swarm via
     postage-stamp relay → `orderRef`.
2. Frontend POSTs `/api/stripe/create-checkout` with `{burnerPubkey,
   orderRef, eventId, qty}`. **Privkey not sent.**
3. Backend:
   - Calls existing **off-chain** `reservation-store.reserve()` (10-min
     TTL, per-clientKey dedup). No chain interaction yet, no gas spent.
   - Stashes `{reservationId, burnerPubkey, orderRef, eventId}` against
     the Stripe `session_id` (file-backed, like today). **No privkey
     stored.**
   - Creates Stripe Checkout session, returns URL.
4. **If sold out or reservation cap hit**: backend returns 409 to
   frontend — Stripe never opens, no payment taken, no gas spent.
5. Buyer redirected to Stripe Checkout. Pays card.
6. Stripe webhook (`checkout.session.completed`) fires:
   - Backend looks up `{burnerPubkey, orderRef, eventId, ...}` by
     session_id.
   - Calls `claimFor(eventId, burnerPubkey, orderRef)` from sponsor wallet.
   - Contract atomically allocates next slot; emits `SlotClaimed`.
   - Off-chain reservation consumed via existing late-consume logic.
   - **Race case**: if `claimFor` reverts (sold out — another buyer's
     webhook beat this one through the chain despite the off-chain hold):
     backend triggers Stripe refund using existing partial-refund path.
7. Backend retrieves the pre-uploaded POD ref for the allocated slot from
   the event's editions manifest on Swarm.
8. Backend sends email:
   - Subject: "Your ticket for {event}"
   - Composite ticket PNG attachment
   - Link to `/t/{eventId}/{slot}/{sig}` HTML page
   - **No private key, no recovery code.** The email is the ticket; the
     key stays in the buyer's browser.
9. Frontend (still open on the success page) polls
   `/api/tickets/by-session/{sessionId}` until webhook completes →
   receives `{eventId, slot, podRef, ticketPageUrl}`.
10. **On success page**: browser reads burner privkey from localStorage
    → signs the buyer's own collection feed update appending
    `{eventId, edition: N, podRef}`. Backend not involved in this
    signing. Page also offers an optional "Download backup of your
    ticket key" button — opt-in, never automated.

### Failure cases

| Failure | Behaviour |
|---|---|
| Sold out at "Pay" click | Off-chain reservation refuses (no slots) → 409 to frontend → no Stripe, no gas |
| Buyer abandons Stripe Checkout | Off-chain TTL expires → slot freed for next buyer |
| Stripe payment fails | No webhook → reservation expires naturally → no claim |
| Two webhooks race for last slot | First `claimFor` succeeds, second reverts → backend refunds loser via existing partial-refund logic |
| Backend crash mid-flow | Stripe retries webhook (1h tolerance); session_id replay-prevention store ensures exactly-once processing |

Off-chain TTL is **20 min** (was 15) — covers 3DS bank challenges
without holding inventory too long. Race past the off-chain hold is rare
(near-zero in practice — the off-chain hold catches almost everything)
and refundable via existing partial-refund logic in
`apps/server/src/routes/stripe.ts`. The chain provides the final
uniqueness guarantee. The chain-revert case plugs into the same refund
path as today's "ticket already claimed" branch — not a new design,
just an additional trigger.

### Why refund probability is asymptotically — but never provably — zero for Stripe

Stripe takes the money **before** the chain can know about it, so there's
always a non-atomic boundary between "money taken" and "slot allocated".
The off-chain reservation reduces the race window to vanishingly rare,
but cannot eliminate it without re-introducing on-chain reserves
(which opens gas-griefing). Engineer the rare-refund path to be cheap
and idempotent; accept that absolute zero is not reachable with Stripe.

For **crypto payments via `payAndClaim`** (v1.5+), refund probability is
**structurally exactly zero**: payment and slot allocation happen in the
same EVM transaction, so atomicity is free. Either the tx reverts (no
money moved, no slot allocated) or it succeeds (both happened). The
"refund" concept doesn't apply on-chain. Phase 1 signed-quote pattern
moves into the contract: contract validates the HMAC-signed
`PaymentQuote`, accepts the exact wei it commits to, slot allocated
atomically. Oracle slippage is solved at quote time, not at payment
time. **This is one of the strongest arguments for prioritising v1.5
crypto sooner** — it eliminates an entire class of operational failure
that Stripe can never structurally fix.

## Email & free-event flows

### Free / RSVP claims

**OUT OF SCOPE FOR v1.** v1 ships paid-only. Free events continue on the
existing platform-signed flow until v1.5+. Sketch retained below for
when we wire it in:

1. Buyer fills RSVP form. Browser generates burner keypair, encrypts order
   SealedBox, uploads to Swarm.
2. Backend (rate-limited per IP/email) calls `claimFor(eventId,
   burnerPubkey, orderRef)` directly. ~$0.005 sponsor gas.
3. POD ref lookup + email send identical to Stripe flow.

For very high-volume free events where $0.005/claim adds up, route to the
off-chain log + on-chain anchor pattern (see "Pattern B" notes below).

### Key lifecycle and loss recovery

The burner key is **dormant in v1** — there are no buyer-callable contract
functions. Door entry is QR-based (POD signature + path sig); the key is
not challenged. So losing the key in v1 has zero impact on attending the
event.

**What loss means by scenario:**

| Lost | Impact (v1) | Recovery |
|---|---|---|
| Browser localStorage (cache cleared, new device) | None for v1 entry. Loses the ability to sign own collection feed updates and to upgrade to a stable WoCo account using the burner key | Optional manual backup downloaded at checkout; or upgrade via email-magic-link instead (organiser dashboard has email → can re-bind slot to a new key on rotation) |
| Email | QR is gone | Organiser dashboard has email mapping; can resend `/t/` link from chain event |
| Both | Door entry blocked | Organiser does manual ID verification at door, same as today's "lost ticket" handling — all data still on chain + in dashboard |

**Upgrade paths to a stable identity (v1.5+)**:
1. **Email-magic-link rotation**: buyer proves email control → platform
   calls `transferOwnership(slot, newKey)` → no burner key required for
   the rotation. Works even if buyer lost their browser.
2. **Burner-key rotation**: buyer signs a transfer with their existing
   burner key → slot moves to their new stable WoCo account key.
3. **Passkey + ERC-4337 smart account**: end-state. Buyer's stable WoCo
   identity is a passkey-controlled smart contract wallet; private
   material never leaves secure enclave. Historic burner-owned PODs
   migrate via either path above.

## Door check-in (no backend involvement)

Door check-in is a fully client-side, organiser-controlled flow. No
backend in the runtime path.

### Scanner app (organiser's phone/tablet, loaded pre-event)

Caches before the event:
- POD manifest from Swarm (all N PODs for the event — refs + metadata)
- Chain `slotOwner` snapshot (one query, then watches `SlotClaimed` events
  if online)
- Organiser's signing key for writing check-in entries (passkey-protected
  on device)

### Check-in flow

1. Decode QR → `{eventId, slot, sig}`.
2. **Local** verify path sig matches the URL signing key → QR isn't forged.
3. **Local** verify the POD at slot N exists in cached manifest, ed25519
   signature against organiser pubkey is valid.
4. **Local** check the device's consumed-slots set. If slot already
   present → reject (prevents double-entry).
5. If new: mark slot consumed, append entry to a Swarm feed
   `woco/event/{eventId}/checkins` signed by the organiser's check-in
   key. Entry: `{slot, timestamp, scannerDeviceId}`.
6. Other scanner devices read this feed → see consumed slots near
   real-time, prevents the same QR being scanned at door A then door B.

### Burner key is **never** challenged at the door

Door check-in is an organiser-side state transition: "I'm marking this
slot consumed in my own records." The buyer presents the QR + POD; that's
sufficient. No signature challenge from the buyer's burner key. This is
deliberate:

- Sign-at-door would lock buyers out of the venue if they lost browser
  state, hurting UX with no security benefit
- Ticket-sharing prevention is handled by "first scan wins" + organiser
  scanner UX (which is how high-value events work today, even without
  cryptographic keys)
- Keeps the burner key dormant in v1 → no v1 recovery story needed for it

### Offline support

Scanner caches everything pre-event. Works fully offline. Check-ins queue
locally; sync to the Swarm feed when network returns. Feed entries are
CRDT-style on `slot` (additive, idempotent) so multiple offline scanners
converge cleanly.

## Long-term POD vision

PODs are designed as **durable digital assets**, not one-shot ticket QRs.
The architecture supports this from day one and the v1 design should not
compromise it. Future use cases (in approximate order of likelihood):

### PODs as persistent identity primitives

A POD is a self-contained, organiser-signed, content-addressed Swarm
artefact. Once minted it outlives the event indefinitely. Format
versioning (`woco.ticket.v2`, `woco.badge.v1`, etc.) means new POD types
can extend without breaking the verifier. POD ownership records on chain
are permanent.

### Stable WoCo accounts

Buyers eventually create a passkey-backed smart account (ERC-4337) — one
identity that owns all their PODs across events. Private material stays
in the device secure enclave. Historic burner-owned PODs migrate to this
account via either email-magic-link rotation or burner-key signature.

### Importing historic PODs

Once a buyer has a stable WoCo account, they can import all prior
attendance:
1. Prove email control via magic link, **or** sign with the original
   burner key.
2. Platform calls `transferOwnership(eventId, slot, newAccount)` for each
   slot.
3. All historic POD ownership rebinds to the stable account on chain.
4. Their collection feed is now `woco/pod/collection/{newAccount}`.

The chain is the source of truth so this migration is publicly verifiable.

### PODs as access tokens / collectibles

Examples of what becomes possible:
- **Football club season membership**: 20 PODs from a club's home games
  combine into a "gold member" emblem (separate POD or smart contract)
  that grants access to exclusive chat groups, merch drops, future
  ticket priority
- **Conference attendance proofs**: holding the Devcon 2025 + 2026 +
  2027 PODs unlocks early access to 2028 tickets
- **Venue loyalty**: 10 PODs from a pub's events grants tap-room access
- **Governance / voting**: token-curated registries weighted by attendance
- **Provenance for resale**: secondary markets verify "this seat was
  originally bought directly from the organiser"

The verification primitive is the same in every case: an external service
challenges a user → user signs with their stable account key → service
reads chain to confirm POD ownership. Fully decentralised, no platform
middleman.

### Why this matters for v1 design

A few things click into place when long-term composability is the anchor:

1. **Don't make the burner key load-bearing for anything in v1.** Provenance
   only. Avoids elaborate key-recovery flows for a key the buyer doesn't
   need to use.
2. **POD schema is asset-shaped, not ticket-shaped.** Generous metadata,
   format versioning, durable image refs, issuer-signed. Already correct
   in this design — keep it that way; resist event-specific creep.
3. **Collection feed is the user's portfolio.** Already the right
   abstraction. Migrates cleanly when stable accounts arrive.
4. **Multi-event organiser flows scale naturally.** A football club running
   20 home games per season has 20 events in their creator directory; fans
   accumulate 20 PODs in their collection feeds; emblem/access logic reads
   from there. No new infrastructure required.
5. **The on-chain composability story is the moat.** Ticketmaster sells
   tickets. WoCo's PODs are inputs to other on-chain logic — emblems,
   chat gates, future-event recognition. Architecture must protect this.

## What the backend signs

| Today | Pattern A v1 |
|---|---|
| Editions feed (per claim) | Nothing |
| Claims feed (per claim) | Nothing |
| Claimers feed (per claim) | Nothing |
| Pending-claims feed | Nothing (approval flow TBD) |
| User collection feed (per claim) | Nothing — buyer signs client-side on success page |
| User profile feed | Nothing — user signs |
| Event metadata feed | Nothing — organiser signs |
| Stripe sponsor wallet on chain | `claimFor` (only on webhook receipt) |

The platform's only persistent signing key in the new model is the **chain
sponsor wallet** — used solely to pay gas on behalf of Stripe/email buyers.
That's a payment relay, not a custodial signer.

**Burner private keys never touch the backend** — generated client-side
in the buyer's browser, stored in localStorage, used only by the buyer.

## Long-term backend phase-out

User explicitly wants to minimise backend role over time. With this
architecture, the surviving backend responsibilities are:

**Unavoidable (centralised dependency)**:
- Stripe webhook receipt + processing.
- Email send (could move to a serverless transport later).
- Sponsor wallet for paying gas on Stripe/email claim txs.

**Already removed in this design**:
- POD generation → done at event creation, not claim.
- Feed writes → user signs own collection, organiser signs own event
  metadata, burner key generated client-side.
- Burner key handling → fully client-side; backend never sees a private key.
- Door check-in → organiser-signed Swarm feed, no backend in the path.

**Removable in future versions**:
- Sponsor wallet → eliminated for crypto buyers (they pay their own gas
  via `payAndClaim`). Stays for Stripe by necessity.
- Stripe webhook → unavoidable while card payments are part of the offer.
- Email send → could move to a serverless transport later.

**For crypto buyers (v1.5+)**: backend involvement is zero in the hot
path. Buyer's wallet → contract → POD on Swarm → buyer's collection feed
signed by buyer. Backend only needed for ticket page rendering, which is
public/cached.

## Implementation work estimate (Stripe-only v1)

Single dev, focused, knows the codebase. **Model column** = recommended
Claude model. Use Opus where novel design decisions branch on tradeoffs;
switch to Sonnet once the surface is locked and execution is mechanical.

| Phase | Effort | Model |
|---|---|---|
| Solidity contract + tests (new `WoCoEvent.sol`, NOT extending escrow) | 2–3 days | **Opus** — security-critical |
| Deploy scripts (Base Sepolia + Base mainnet + Optimism mainnet failover-ready) | 1 day | Sonnet |
| Canonical POD encoder + leaf format + Merkle tree builder (lock spec, write test vectors) | 1–2 days | **Opus** — cryptographic spec, locked permanently |
| Event-creation flow: build tree, sign manifest, upload Mantaray, on-chain register | 1–2 days | Sonnet (mechanical once spec is locked) |
| Frontend: client-side burner keygen + keypair-ownership sig + localStorage + SealedBox upload | 2 days | **Opus** (sig binding spec), then Sonnet to implement |
| Backend: webhook → verify keypair sig → `claimFor` → POD lookup → email send | 3–4 days | **Opus** — refund-on-revert path needs care |
| Backend: sponsor wallet + gas budget + balance alerting | 1–2 days | Sonnet |
| Frontend: success-page poller (NO collection-feed signing in v1) | 1 day | Sonnet |
| Frontend: organiser event-creation UX (single-sig manifest confirm + tree-build progress for huge supply) | 2 days | Sonnet |
| App split — `toolbox.woco.eth` build + ENS sub-name + BZZ deploy | 2–3 days | Sonnet |
| Door scanner app `scan.woco.eth`: offline manifest cache, local POD verify, organiser-signed check-in feed | 2–3 days | **Opus** (offline + sync design), Sonnet to build |
| End-to-end testing on Base Sepolia | 3–4 days | Sonnet |
| Parallel-run with old flow + production cutover | 2–3 days | **Opus** — cutover is high-stakes |

**Total: ~4 weeks focused work.**

External audit: skip for v1 (no `payable` on the contract → no value at
stake → blast radius bounded by sponsor wallet balance ≈ <$10). Slither
+ Foundry fuzz + peer review of ~100 LOC is sufficient. Revisit audit
decision when `payAndClaim` ships in v1.5 and the contract starts holding
ETH/USDC for crypto buyers — *that's* when an audit earns its keep.

### Model-switch checkpoints

When you hit one of these, **prompt the user before switching to Sonnet**
to confirm the design surface is locked:

1. **After contract surface is finalised** (eventId derivation, sponsor
   set semantics, manifestRef storage) → contract implementation + tests
   can move to Sonnet.
2. **After canonical encoding + leaf format + manifest schema are
   locked** with test vectors → tree builder + manifest signer to
   Sonnet, Svelte event-creation UX to Sonnet.
3. **After Stripe webhook flow is specified end-to-end** (verify sig →
   `claimFor` → revert handling → refund integration → email) → backend
   route implementation to Sonnet.
4. **After app-split scaffolding is decided** (Vite config shape, package
   exports, ENS subname plan) → mechanical file moves + per-app build
   config to Sonnet.

Stay on Opus for: scanner offline-sync design, production cutover plan,
any change to `slotOwner` or `claimFor` semantics post-deploy, threat
model review before mainnet, and the `payAndClaim` design when it ships.

## Migration sequencing (low-risk first)

1. **Lock canonical encoding + leaf format + manifest schema.** Write
   test vectors. This is the foundation everything else depends on.
2. **Contract deploy on Base Sepolia**. Self-test `claimFor` end-to-end
   from a script.
3. **Stripe path on Sepolia + a test paid event**. Validate
   reserve / `claimFor` / refund-on-revert flow with real Stripe test
   webhooks. Manifest pattern in use from this step on.
4. **App split scaffolding** — `toolbox.woco.eth` and `scan.woco.eth`
   builds. Can ship independently of v1 cutover; reduces risk of doing
   it under cutover pressure later.
5. **Mainnet cutover** — Stripe paid events only, manifest pattern,
   no supply cap. Legacy paid flow stays available; new events use
   Pattern A.
6. **Add `payAndClaim` for crypto buyers** — v1.5. Refund probability
   structurally zero for the crypto path.
7. **Migrate free events to Pattern A** — v1.5+, alongside crypto path.
8. **User-owned feeds → user signers** (collection, profile, avatar) —
   v1.5+. Currently retained platform-signed.
9. **Global directory cleanup** — on-chain registry or aggregated
   derivation from per-organiser feeds.

## Open questions / design decisions

1. **POD manifest storage**: Mantaray collection (single Swarm ref, all
   PODs grouped) vs JSON manifest in event-metadata feed vs sub-feed
   `woco/event/{eventId}/editions`. Lean Mantaray collection — single
   immutable ref the chain registration can include for verification.
2. **POD claimer-field removal**: requires schema bump. New format
   `woco.ticket.v2` with no `claimedBy`. Verifier dual-supports v1
   (claimer in POD) and v2 (claimer from chain) during migration.
3. **Audit decision**: external audit before mainnet vs self-review.
   Lean self-review for free events; revisit when paid volumes scale.
4. **Refund logic**: organiser-initiated refunds, buyer cancellations.
   Out of v1 scope; design separately. Chain `slotOwner` rewind is the
   primitive; UX layer TBD.
5. **Sponsor wallet funding**: manual top-ups from platform treasury.
   Eventually fund from accumulated platform fees.
6. **Burner key UX**: client-side keygen + localStorage from day one.
   Optional manual backup at checkout. Upgrade path to passkey + ERC-4337
   smart account in v1.5+. Never emailed in plain text — never emailed
   at all.
7. **Discovery directory**: keep platform-signed for now (narrow
   surviving role), or replace with on-chain registry / per-organiser
   aggregation.
8. **Reservation TTL**: **20 min** covers Stripe checkouts including 3DS
   bank challenges without holding inventory too long. Edge cases at the
   boundary trigger refund-on-fail. Off-chain only; on-chain claim happens
   at webhook receipt (gas-griefing safe).
9. **Event registration funding**: organiser pays the ~$0.01 themselves
   (need their own wallet) vs platform sponsor pays. Lean platform
   sponsor for v1 (frictionless organiser onboarding).

## Reference: what was rejected and why

- **Off-chain queue with multi-witness co-signing** (Pattern B): more work
  than Pattern A, needs witness recruitment, weaker latency variance.
  Right shape for free events later, not for paid v1. Optional layer
  for high-volume free events.
- **TEE (Intel SGX / AWS Nitro)**: shifts trust to chip vendor; useful
  future hardening, not v1.
- **zkVM proofs**: bleeding-edge tooling; revisit in 2–3 years.
- **Permissioned BFT chain**: ops-heavy, only justified at federation
  scale.
- **Client-side decryption of writer key**: catastrophic — any buyer
  could forge slots.
- **Claim-time POD generation**: rejected in favour of pre-signed PODs
  at event creation. Removes signing from hot path; eliminates downtime
  risk during sales spikes.
- **Server-side burner keygen + email-the-key**: rejected. Plain-hex
  private keys in email is below the security bar for any system handling
  payments — fails audit, creates phishing handles, exposes ESP/email
  storage to key compromise. No upside in v1 because v1 has no buyer-
  callable contract functions; the key is dormant. Client-side keygen +
  localStorage gives equivalent functionality without ever putting the
  key on the wire.
- **Sign-at-door challenge**: rejected for v1. Adds UX friction (buyer
  needs key on a device at the door), locks out anyone who lost browser
  state, prevents only one specific attack (QR sharing) that's already
  handled by "first scan wins" + scanner UX. Burner key stays dormant.

## Files likely affected

- `contracts/src/WoCoEvent.sol` — **new contract**, NOT an extension of
  `WoCoEscrow.sol`. Escrow holds value; this one doesn't. Keep them separate.
- `contracts/script/DeployEvent.s.sol` — new deploy
- `contracts/test/WoCoEvent.t.sol` — full test suite + Foundry fuzz
- `apps/server/src/routes/events.ts` — event creation: pre-sign PODs,
  upload manifest, register on chain
- `apps/server/src/routes/stripe.ts` — webhook calls `claimReserved`
- `apps/server/src/routes/claims.ts` — replace claim handler with
  chain-aware logic; add `/api/tickets/by-session/{id}` poll endpoint
- `apps/server/src/lib/event/claim-service.ts` — retire most of it
- `apps/server/src/lib/event/reservation-store.ts` — keep as-is (off-chain
  soft hold remains the UI source of truth)
- `apps/server/src/routes/reservations.ts` — keep; webhook now also calls
  the chain after consuming the reservation
- `apps/server/src/lib/payment/verify.ts` — most logic moves into contract
  (deferred to v1.5 for crypto path)
- `apps/server/src/lib/chain/sponsor.ts` — new: sponsor wallet client
- `apps/server/src/lib/chain/event-listener.ts` — new: chain event watcher
- `apps/web/src/lib/burner/keygen.ts` — new: **client-side** burner
  keypair generation + keypair-ownership signature + localStorage
  management (NOT server-side)
- `apps/web/src/lib/burner/collection-feed.ts` — **DEFERRED to v1.5.**
  No buyer collection-feed writes in v1.
- `apps/web/src/lib/components/events/ClaimButton.svelte` — keygen on
  order-form submit, send `{pubkey, ownershipSig}` to checkout endpoint
- `apps/web/src/lib/components/events/StripeSuccess.svelte` (or similar)
  — new/updated: poll `/api/tickets/by-session/{id}` for ticket ref +
  show success card. **No collection-feed signing in v1.**
- `apps/web/src/lib/components/events/EventCreate.svelte` — manifest
  pattern: build tree, sign single manifest, upload Mantaray, register
- `apps/scanner/` (new package) — door-scanner PWA at `scan.woco.eth`:
  offline-capable, POD manifest cache, organiser-signed check-in feed
  writer. Separate Vite build.
- `apps/toolbox/` (new package) — organiser app at `toolbox.woco.eth`:
  builder + dashboard + event create + Stripe Connect. Separate Vite build.
- `apps/web/src/lib/api/sites.ts` — adjacent changes
- `packages/shared/src/pod/types.ts` — new `woco.ticket.v2` format
  (no `claimedBy`) + `woco.manifest.v1` schema
- `packages/shared/src/pod/canonical.ts` — **new**: DAG-CBOR canonical
  encoder for POD bytes + leaf hash function (locked spec, test vectors)
- `packages/shared/src/pod/merkle.ts` — **new**: tree builder + proof
  generator (wraps `@openzeppelin/merkle-tree`)
- `packages/shared/src/pod/verify.ts` — dual-support v1 + v2; verifies
  manifest sig + Merkle proof against chain `manifestRef`

## Conventions reminder for new chat

Before recommending implementation, read `CLAUDE.md` and the relevant
memory files. Especially:
- `docs/CRYPTO_AUDIT_2026-04-08.md` — auth/security baseline
- `docs/SECURITY_FIXES_2026-04-09.md` — recent hardening
- `docs/PAYMENTS_PHASE_2.md` — original Phase 2 design (this plan
  supersedes; prefer this doc)
- `memory/project_crypto_payments.md` — payment shipping state
