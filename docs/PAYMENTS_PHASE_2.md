# Payments Phase 2 — Atomic Mint

**Status:** design, not scheduled
**Author:** initial draft 2026-04-18
**Depends on:** Phase 1 (signed-quote exact-match verification) — shipped 64e4faa
**Related:** `contracts/src/WoCoEscrow.sol`, `apps/server/src/routes/claims.ts`, `apps/server/src/lib/payment/verify.ts`

## Why this exists

Phase 1 closed the **pricing** gap: the server HMAC-signs a quote committing to an
exact `amountWei`, the wallet pays exactly that, the server verifies by
exact-match against `tx.value`. No more oracle race, no more "paid 0.00054 but
expected 0.00055" failures. Funds are only verified against the same number the
wallet paid.

What Phase 1 does **not** close is the **atomicity** gap. There are still two
separate steps:

1. **Payment** — on-chain, irreversible once confirmed
2. **Mint** — off-chain, writes a ticket edition to a Swarm feed

A user can pay successfully and then the mint can fail:

- server crashes between verify and feed write
- Bee node goes down
- Swarm feed write hits a transient error past the retry budget
- concurrent claim wins the last slot (we guard with an in-flight lock but the
  lock is in-memory — a restart during confirmation wait would lose it)
- series is deleted by the organiser between quote issuance and claim settlement
- the POD signing key is unavailable (bug, migration, revocation)

In all of these the user's money is already on-chain. We partially mitigate
today:

- Escrow path: organiser can't withdraw until `releaseTime`, so a disputed
  payment can be refunded by the arbitrator via `resolveDispute(eventId, false)`.
  Manual, slow, trust-based.
- Direct transfer path: no recovery at all — funds are in the organiser's EOA.
- `.data/consumed-quotes.json` prevents replay of a successful claim, but does
  not protect against a mint that never happened.

Phase 2 eliminates the window by making payment and mint a single atomic
on-chain action. Either both happen or neither does, enforced by the EVM.

## Design space

Three shapes, ordered by lift.

### Option A — On-chain mint commitment, off-chain data

A minimal contract that records `(seriesId, claimer, paymentAmount)` in storage
as part of the same transaction that receives payment. The off-chain ticket
(POD edition on Swarm) is still produced by the server, but only claims backed
by an on-chain commitment are valid.

Flow:

1. Client requests signed quote (Phase 1, unchanged)
2. Client calls `Ticketing.pay(quoteId, sig, seriesId, claimer)` with
   `msg.value = quote.amountWei`. Contract verifies the quote signature
   (ECDSA recover against a known signer) and records
   `commitments[keccak256(quoteId, claimer)] = true`.
3. Server watches events or is given the tx hash; mints the POD edition only
   if the on-chain commitment exists.
4. If the server fails to mint, the commitment stays. A second call to
   `/api/claim` with the same tx produces the ticket. A separate
   `refundStale(quoteId)` path lets the user pull funds back after a grace
   window (e.g. 24h) if no edition was ever minted.

Pros:
- Small contract, easy to reason about
- Works for both ETH and USDC (ERC-20 `transferFrom` inside `pay`)
- Escrow can layer on top — the contract just splits into custodial vs instant
- Refund path is on-chain, not arbitrator-mediated

Cons:
- Off-chain mint can still fail permanently; refund is a separate user action
- Doesn't verify the mint actually happened, only that payment did
- Requires the quote signer's address to be registered on-chain (key rotation
  becomes a governance action)

### Option B — On-chain ticket NFT, atomic mint

The ticket itself becomes an ERC-721 or ERC-1155. The contract mints the
token in the same transaction that takes payment; if the mint reverts
(sold out, already claimed, series expired), the payment reverts too. The
POD edition on Swarm becomes a signed attestation *derived from* the
on-chain token, not the source of truth.

Flow:

1. Server pre-registers the series on-chain at event publish time:
   `Ticketing.registerSeries(seriesId, priceWei, totalSupply, recipient, podSigner)`
2. Attendee calls `Ticketing.mint(seriesId, claimer)` with `msg.value = priceWei`.
   Contract checks supply, increments edition, transfers/escrows payment,
   emits `Claimed(seriesId, editionNumber, claimer)`. If any check fails, the
   whole tx reverts — wallet sees the revert, no funds move.
3. Server indexes `Claimed` events and writes the corresponding POD edition
   to Swarm as a convenience (for embed/discovery), but the NFT itself is
   the canonical ticket.

Pros:
- True atomicity — payment and mint succeed or fail together, enforced by EVM
- No "paid but not minted" state is even representable
- Tickets are now portable ERC-721s — third-party wallets, marketplaces, etc.
- Eliminates most of the claim-service complexity (supply tracking, lock queue)

Cons:
- Biggest lift: contract owns supply, pricing, access control
- Every series costs gas to register (amortised across its claims, so small)
- Approval-gated events, email claims, and free claims all need separate
  paths — the NFT model assumes a paying wallet
- POD identity + Swarm feed model becomes secondary; large chunks of the
  server become event-indexers instead of authorities
- Per-chain deployment means a series is bound to one chain (today any chain
  in `acceptedChains` works)
- Gas cost pushes back against the "free ticket" and "£2 ticket" use cases on
  mainnet — fine on L2s, painful on L1

### Option C — Escrow + confirmation callback

Keep off-chain minting, but extend `WoCoEscrow.sol` so that `payETH`/`payToken`
*records the claimer address* in storage and emits `PaidFor(seriesId, claimer,
amount)`. Server listens; if mint fails, a new contract method
`refundFailedMint(eventId, claimer)` lets the payer pull their funds back
before `releaseTime`. Organiser can't release funds for a claim that never
materialised as a POD edition (we'd enforce this via an arbitrator-signed
attestation at release time, or a merkle root of minted claims).

Pros:
- Smallest incremental change — extends the existing escrow
- Keeps the POD-first architecture intact
- Refund path is self-serve, not arbitrator-mediated

Cons:
- Still not truly atomic — there's a window between pay and mint where
  the user has to trigger a refund
- Refund requires the user to notice + come back, which many won't
- Doesn't help the direct-transfer path (which bypasses escrow entirely)

## Recommendation

**Option A for the next iteration**, with the long-term goal of **Option B**
once the platform has enough volume to justify the contract surface area.

Rationale:

- Option A is a few hundred lines of Solidity, tested in isolation, and
  slots into the existing claim flow as a pre-check. It gives us self-serve
  refunds without committing to on-chain supply tracking.
- Option B is the right end-state (ticket NFTs are an interesting product
  surface — resale, staking, composability) but it's a significant rewrite
  of the claim service and doesn't pay for itself yet.
- Option C is worse than A on both effort and outcome — we'd rather invest
  in a proper commitment contract than bolt more logic onto escrow.

## Out of scope

- **Free claims**: these have no payment, so Phase 1 + the existing in-flight
  lock is sufficient. No contract changes.
- **Email claims**: the payer binding (`claimerProof` EIP-191 sig) already
  handles front-running. Phase 2 only matters when money changes hands.
- **Stripe**: atomic mint is a crypto-path problem. Stripe's webhook retry
  loop + `refundCharge` on unrecoverable claim failure is the analogous
  solution and it's already in place (see `apps/server/src/routes/stripe.ts`).

## Open questions

1. Quote signer key on-chain: hot key (cheap rotation, higher blast radius)
   or multi-sig (harder rotation, safer)?
2. Refund grace window: 1h, 24h, until `releaseTime`? Shorter = better UX,
   longer = more time for server recovery.
3. Chain selection: deploy Option A on every chain in `acceptedChains` or
   pick one primary (Base) and treat others as Phase-1-only?
4. Does Option A need to replace escrow or live alongside it? The escrow's
   dispute resolution is useful for cancelled events, which Option A doesn't
   address — they're orthogonal concerns and both should probably stay.
5. Gas abstraction: should the contract support EIP-2771 meta-tx so the
   server can sponsor claim gas for passkey users? Probably out of scope
   for v1 but worth keeping the door open.

## What Phase 1 buys us in the meantime

Phase 1 already prevents the most common failure mode — slippage between
quote and verify, which is what users actually hit in production. The
remaining "paid but not minted" window is:

- rare (requires server failure *during* a specific 2-5 minute confirmation
  window)
- recoverable via escrow dispute on escrow-enabled events
- manually refundable via tx reversal on direct-transfer events (organiser
  cooperation required)

So Phase 2 is a robustness upgrade, not a blocker. Ship Phase 1, watch
production, then re-evaluate priority once we have real failure data.
