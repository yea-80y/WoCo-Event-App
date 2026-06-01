# WoCoEventV2 — Handover (2026-05-26)

Drafted in the same chat as the Coinbase Smart Wallet Day-2 work, on top of
the post-compaction context. This doc covers ONLY the V2 contract refactor;
buildathon context lives in `docs/ARBITRUM_BUILDATHON_*`.

---

## What shipped in this chat

Three files (uncommitted, in `contracts/`):

- `contracts/src/WoCoEventV2.sol` — full rewrite
- `contracts/test/WoCoEventV2.t.sol` — 57 tests, all pass
- `contracts/script/DeployEventV2.s.sol` — Arbitrum Sepolia / One / Base targets

```
forge test --match-contract WoCoEventV2Test
# 57 passed; 0 failed; 0 skipped
```

### Design (one-paragraph)

USDC-settled (token configurable at construction). Buyer pays the contract
directly — funds sit in per-event escrow until `eventEndTs + releaseDelay`,
then `withdraw` pays organiser (97.5%) + platform treasury (1.5% default,
per-event override). If organiser calls `cancelEvent` before withdraw, each
buyer pulls their own refund via `claimRefund`. Stripe webhook path
(`claimFor` / `batchClaimFor`) coexists — sponsor mints slot without
pulling tokens; Stripe handles its own refunds off-chain so the slot is
flagged `batchEscrowed = false` and excluded from on-chain refunds.

### Public/external surface

| Function | Caller | Pays | Notes |
|---|---|---|---|
| `registerEvent(supply, priceBaseUnits, payoutRecipient, dropGate, manifestRef, eventEndTs)` | organiser | — | Stamps fee bps + release delay at creation; immutable per event |
| `payAndClaim(eventId, owner, orderRef)` | buyer (or agent for owner) | USDC | Requires prior `approve` |
| `payAndClaimWithPermit(...)` | buyer | USDC | One-tx via EIP-2612 |
| `batchPayAndClaim(eventId, owners[], orderRef)` | buyer | USDC | n ≤ 100 |
| `claimFor(eventId, owner, orderRef)` | authorised sponsor | none | Stripe path |
| `batchClaimFor(...)` | authorised sponsor | none | Stripe path |
| `cancelEvent(eventId)` | organiser | — | Opens refunds, blocks withdraw |
| `withdraw(eventId)` | organiser | — | Only after `eventEndTs + releaseDelay`; not cancelled; not frozen |
| `claimRefund(eventId, slot)` | buyer | — | Only if cancelled; per-slot once |
| `freezeEvent(eventId, bool)` | dispute authority | — | Pauses withdraw only |
| `forceCancelEvent(eventId)` | dispute authority | — | Opens refunds; cannot move funds |
| `setDisputeAuthority(addr)` | owner | — | Rotatable to DAO multisig |
| `setDefaultReleaseDelay(seconds)` | owner | — | New events only; max 30 days |

Views: `getEvent`, `getEventStatus`, `releaseTime`, `escrowOf`, `isSlotRefunded`.

### Security posture

- OpenZeppelin v5 (`Ownable2Step`, `ReentrancyGuard`, `SafeERC20`).
- All fund-moving entrypoints are `nonReentrant` — including the legacy
  sponsor paths (`claimFor`, `batchClaimFor`) hardened in this chat.
- CEI strictly observed: drop-gate runs AFTER slot state writes in both
  `_payAndClaim` and `batchPayAndClaim` (fix applied in this chat).
- `tx.from` invariant preserved through `safeTransferFrom(payer, ...)`.
- `SalesClosed` gate at `block.timestamp >= eventEndTs` on all 4 claim
  paths — closes the post-withdraw-deposit edge case.
- Dispute authority has NO ability to move funds — only flips `frozen` and
  `cancelled` flags. Refunds always go to the original payer of each batch.
- Per-batch escrow flag (`batchEscrowed`) means Stripe slots can't be
  refunded on-chain (Stripe owns those funds).
- Per-slot refund flag (`slotRefunded`) prevents double-refunds inside a
  cancelled batch.

A `/security-review` plugin pass flagged the gate-reentrancy concern that
prompted the CEI + `nonReentrant` hardening; the residual finding was a
worst-case defense-in-depth issue (an authorised sponsor could already
mint free tickets directly), not actual fund theft.

---

## What is NOT done yet

The contract is **drafted + tested, NOT deployed, NOT integrated**.

Deferred to the next chat (in priority order):

1. **Deploy V2 to Arbitrum Sepolia** via
   `forge script script/DeployEventV2.s.sol --rpc-url arb_sepolia --broadcast --verify`.
   Needs `DEPLOYER_PRIVATE_KEY` env. Confirm USDC default
   (`0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`) is the canonical Arbitrum
   Sepolia faucet USDC before broadcasting.
2. **Server integration** —
   `apps/server/src/lib/chain/event-contract.ts` reads V1 ABI; add a V2
   ABI variant + chain → contract mapping so Arbitrum Sepolia uses V2 and
   Base/Optimism stay on V1. Stripe webhook must call `claimFor`/`batchClaimFor`.
3. **Frontend integration** — `apps/web/src/lib/contracts/woco-event.ts`
   needs V2 address + ABI. ClaimButton wallet-pay path must call
   `payAndClaimWithPermit` (saves the buyer an `approve` tx).
4. **Organiser refund UX** — surface `cancelEvent` in the dashboard, and
   `claimRefund` in MyTickets. None of this exists yet.
5. **Organiser bond at registration** — deferred design. Organiser locks
   N USDC at `registerEvent`; bond returns on `withdraw`, slashes on
   `forceCancelEvent` after dispute window. Hooks already exist; just
   needs a `bondAmount` field on Event + `requireBondAtRegister`.
6. **Dispute bond + on-chain resolution** — current dispute authority is
   trusted (owner initially). Needs: buyer-funded dispute opening, voter
   bond, quorum/threshold, slashing.
7. **`WoCoYieldVault` (Aave companion)** — separate contract, NOT in V2.
   V2 holds principal; vault sweeps idle USDC into aUSDC and reflects
   yield to organisers. Crypto-expert recommendation: keep V2 minimal,
   pull yield into a sibling contract so V2's audit surface stays tight.
8. **Refundable-ticket premium** — buyer-paid add-on for self-serve
   refunds (today only organiser-cancellation triggers refunds). Lives
   on top of V2 without contract changes — likely an off-chain insurance
   pool that mints a separate "refund right" NFT.

---

## Copy-paste resume prompt for the next chat

Paste the whole block below into the new chat, including the headers.

```
We're continuing work on WoCoEventV2 — the USDC-settled escrow refactor
of the events contract — for the Arbitrum Buildathon. The previous chat
hit context limits.

Read these first, in order:
- contracts/src/WoCoEventV2.sol             — the contract
- contracts/test/WoCoEventV2.t.sol          — 57 passing tests
- contracts/script/DeployEventV2.s.sol      — deploy script
- docs/WOCO_EVENT_V2_HANDOVER.md            — full status of what shipped
- docs/ARBITRUM_BUILDATHON_DAY_2_HANDOVER.md — buildathon Day-2 brief
- docs/ARBITRUM_BUILDATHON_SOLO_EXECUTION.md — day-by-day plan + status snapshot

Memory you should already see:
- project_arbitrum_buildathon.md
- feedback_crypto_expert_posture.md
- feedback_client_first_architecture.md
- project_payments_actual_state.md

State right now:
- WoCoEventV2 drafted, 57 tests pass (run `forge test --match-contract WoCoEventV2Test` to verify).
- NOT deployed. NOT wired to server/frontend.
- Coinbase Smart Wallet auth already shipped Day 1 (commit 050a856).
- WoCoEvent V1 is live on Arbitrum Sepolia: 0x172031E6a8428617B05F2002e0e278bb8fb3Ed8A
- Day 2 (Wed 2026-05-27) has a midday feedback session.

The user wants, in priority order (confirm before starting each):
1. Deploy WoCoEventV2 to Arbitrum Sepolia (need DEPLOYER_PRIVATE_KEY in env).
2. Wire server (`apps/server/src/lib/chain/event-contract.ts`) for V2 — per-chain ABI/address routing, Stripe webhook → claimFor.
3. Wire frontend ClaimButton wallet-path to call payAndClaimWithPermit (single-tx via EIP-2612).
4. Surface organiser cancelEvent + buyer claimRefund in dashboard / MyTickets.

Deferred (do NOT start without explicit ask):
- Organiser bond at registration
- Dispute bond + on-chain resolution
- WoCoYieldVault (Aave companion contract — SEPARATE from V2)
- Refundable-ticket premium add-on

Approach reminders:
- Crypto-expert posture: verify USDC addresses against Circle's canonical
  list before any broadcast; keep tx.from invariants intact; preserve raw
  signed bytes through any client/server bridge.
- Commit at logical milestones — small revertable commits.
- contracts/ is a NESTED git repo; commit there separately from the
  outer repo.
- Don't ask before STEP 1/1b/2/3 server deploys to Hetzner; do ask before
  any mainnet broadcast or any destructive git op.
- /security-review plugin works in contracts/ once you set
  `git update-ref refs/remotes/origin/master master` + symbolic-ref
  origin/HEAD; useful before any deploy step.

Start by: reading the four files listed above, then asking which of the
four priority items I want to ship first.
```

---

## Quick verification commands for the new chat

```bash
cd /home/ntl/projects/woco_app/contracts

# Tests
forge test --match-contract WoCoEventV2Test

# Build
forge build

# Dry-run deploy (no broadcast, no env required for read)
forge script script/DeployEventV2.s.sol --rpc-url arb_sepolia

# Broadcast deploy (needs DEPLOYER_PRIVATE_KEY + ARBISCAN_API_KEY)
forge script script/DeployEventV2.s.sol --rpc-url arb_sepolia --broadcast --verify
```

Contract addresses to remember:

- V1 (Arbitrum Sepolia, live): `0x172031E6a8428617B05F2002e0e278bb8fb3Ed8A`
- V2: pending deploy
- USDC (Arbitrum Sepolia, faucet): `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`
- USDC (Arbitrum One): `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`
