# WoCoEventV2 — Security Review Notes (2026-05-26)

Review performed via `/security-review` skill against `contracts/src/WoCoEventV2.sol`
after Arbitrum Sepolia deploy at `0x351070Aff6dECa449506a6eA6dC6cB84D13cAedf`.

## Verdict

No HIGH or MEDIUM findings meeting the ≥8 confidence threshold. Safe to keep
the Sepolia deploy. Two items below for the mainnet checklist.

## Items to pick up later

### 1. `platformTreasury` USDC-blacklist bricks `withdraw` (operational risk)

**File:** `contracts/src/WoCoEventV2.sol` (around `withdraw()`)

**Problem:** `withdraw` does the fee transfer to `platformTreasury` and the net
transfer to `payoutRecipient` in the same tx. If Circle blacklists the
platform treasury address, the fee leg reverts and EVERY organiser's
`withdraw` is bricked simultaneously until the owner calls
`setPlatformTreasury(newTreasury)`.

**Not attacker-controlled** — recoverable. But a single Circle action could
freeze all platform payouts at once.

**Fix options (mainnet only):**
- Pay organiser FIRST, treasury SECOND, so a treasury blacklist doesn't block
  organiser payouts.
- Or wrap the treasury transfer in try/catch and accrue `pendingPlatformFees`
  the owner can sweep later from a new treasury.

### 2. Missing rationale comment on `payAndClaimWithPermit` try/catch

**File:** `contracts/src/WoCoEventV2.sol` (around the `try IERC20Permit(...).permit(...) {} catch {}` block)

**Problem:** The empty catch is the correct mitigation against permit
front-running griefing (attacker lands the signed permit ahead of the user;
nonce consumed; user's permit reverts but allowance is already set so claim
still works). Without a comment, a future maintainer could "fix" it by
reverting on permit failure, re-introducing the griefing vector.

**Fix:** Add a one-line WHY comment, e.g.
`// catch is intentional: prevents front-run griefing of consumed permit nonces`

## Items deliberately NOT reported (below threshold)

- Fee-on-transfer / rebasing payment tokens — owner-controlled at deploy.
- DisputeAuthority abuse / owner rugpull — explicit design choice per NatSpec.
- `payoutRecipient` blacklist bricking single-event withdraw — organiser's own
  recipient choice; they can `cancelEvent` to refund buyers.
- `releaseDelay = 0` accepted by setter — owner choice, per-event stamped.

## Mainnet pre-deploy checklist (when we get there)

- [ ] Address item 1 (treasury blacklist hardening)
- [ ] Address item 2 (permit comment)
- [ ] Separate `platformTreasury` from deployer EOA (use Safe multisig)
- [ ] Rotate `owner` to Safe multisig via `Ownable2Step.transferOwnership`
- [ ] Rotate `disputeAuthority` to DAO/multisig
- [ ] Add `ARBISCAN_API_KEY` and re-verify (Sepolia + One)
- [ ] Re-run `/security-review` after any contract changes
