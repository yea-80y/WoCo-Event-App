/**
 * Recovery guard: refuse to hand an account to a credential that already has one.
 *
 * A web3auth login yields ONE deterministic key per identity. Three stores assume
 * one key means one account — the recovery binding map (key → the Kernel it owns),
 * the POD seed slot (`pod-identity.ts`, keyed by the owner address), and the
 * login-time address caches. `recoverAndRekey`'s web3auth branch is the only place
 * in the codebase that can break that assumption: it points an EXISTING key at a
 * DIFFERENT account.
 *
 * What that costs, if it is allowed to happen:
 *
 *  1. The other account becomes unreachable ON THIS DEVICE. Its seed slot is
 *     overwritten by the recovered account's seed, the binding sends every future
 *     login to the recovered account, and the anti-divergence guards then correctly
 *     refuse to re-derive what was lost. For a one-device user that is permanent.
 *
 *  2. Worse, and less obvious: the two accounts SHARE the AAD, because the AAD is
 *     built from the owner address they have in common. So a seed written for one
 *     decrypts cleanly for the other. If the recovered account is later moved to
 *     another credential, this device's stale-binding guard clears the binding,
 *     falls back to the counterfactual, lands in the ORIGINAL account — and restores
 *     the OTHER account's seed into it, silently. It then signs tickets and decrypts
 *     under the wrong identity, with no error anywhere. The AAD binding is the
 *     cryptographic backstop everywhere else in this design; here it is structurally
 *     blind, because the value both accounts bind to is identical.
 *
 * So this refuses at the only place the state can be created.
 *
 * STOPGAP, deliberately. The real fix is to key the binding by (ownerKey, account)
 * and the seed by (podAddress, parentAddress), so one key CAN own several accounts
 * and (2) becomes impossible rather than merely unreachable. This guard is a
 * prerequisite for that work, not an alternative to it: the migration has to decide
 * whose seed occupies a legacy slot, and on an already-collided device that is
 * unanswerable — the ciphertext and the AAD are identical either way. Blocking here
 * is what guarantees no collided device exists for the migration to mis-attribute.
 * Remove this guard only together with that re-keying.
 *
 * WHY IT FAILS CLOSED, when the rest of the ceremony deliberately does not. The
 * guardian pre-flight proceeds on an unreadable chain, because blocking a locked-out
 * user on an RPC blip would deny them recovery altogether. That reasoning does not
 * transfer: this guard runs BEFORE anything irreversible, and it gates only the
 * email/social variant. The passkey branch mints a fresh credential and cannot
 * collide by construction, so a refusal here costs one click — never the account.
 */

/** Everything the decision needs, gathered by the caller. */
export interface OwnerCollisionEvidence {
  /** The EOA that would become the recovered account's owner (lowercased). */
  newOwnerEoa: string;
  /** The account being recovered (lowercased). */
  targetKernel: string;
  /** Recovery binding already held for this EOA on this device, if any. */
  existingBinding?: string;
  /** Is a POD seed already stored under this EOA? `null` when the read failed. */
  podSeedPresent: boolean | null;
  /** Cached Kernel address for this EOA from a previous login, if any. */
  cachedKernel?: string | null;
  /**
   * On-chain owner of this EOA's counterfactual Kernel: an address when the chain
   * answered, `null` when it answered "no owner", `"error"` when it could not be
   * read. Absence proves nothing — Kernels deploy lazily, so a real account that
   * never transacted is invisible here.
   */
  counterfactualOwner: string | null | "error";
}

export type OwnerCollisionVerdict =
  | { status: "allow"; reason: string }
  | { status: "block"; reason: string; userMessage: string };

/** Shown when we positively know the credential already has an account. */
const MSG_TAKEN =
  "That sign-in already has its own WoCo account. Using it to recover this account " +
  "would make the other one unreachable on this device. Recover to a passkey instead " +
  "(recommended), or use a different email or social login.";

/** Shown when we could not establish that it is free. Deliberately not the same text. */
const MSG_UNSURE =
  "We couldn't confirm that sign-in is free to use. Recover to a passkey instead " +
  "(recommended), or try again in a moment.";

const lower = (v: string | null | undefined): string | undefined =>
  typeof v === "string" && v ? v.toLowerCase() : undefined;

/**
 * Decide whether `newOwnerEoa` may become the owner of `targetKernel`.
 *
 * Pure: all I/O is the caller's. That keeps the policy testable in a file the
 * test harness can actually load, which the store this is called from cannot be.
 */
export function decideOwnerCollision(e: OwnerCollisionEvidence): OwnerCollisionVerdict {
  const eoa = lower(e.newOwnerEoa);
  const target = lower(e.targetKernel);
  if (!eoa || !target) {
    return {
      status: "block",
      reason: "missing owner or target address",
      userMessage: MSG_UNSURE,
    };
  }

  const binding = lower(e.existingBinding);
  const cached = lower(e.cachedKernel);

  // (0) IDEMPOTENT REPAIR — re-running recovery of the SAME account onto the SAME
  // credential must stay open. It is how a user recovers from a ceremony that died
  // partway, and it creates no collision: the slots it overwrites are already this
  // account's own. Checked first so no later rule can refuse a repair.
  if (binding && binding === target) {
    return { status: "allow", reason: "binding already points at this account — repair path" };
  }

  // (1) This credential is already bound to a DIFFERENT recovered account. The seed
  // that would be overwritten came from an escrow and cannot be re-derived even in
  // principle, so this is the most destructive case, not the least.
  if (binding && binding !== target) {
    return {
      status: "block",
      reason: `already bound to a different recovered account (${binding})`,
      userMessage: MSG_TAKEN,
    };
  }

  // (2) The chain says this credential's own account exists and it owns it.
  //     Device-independent, and the only signal that catches an account this
  //     device has never seen.
  if (e.counterfactualOwner !== null && e.counterfactualOwner !== "error") {
    if (lower(e.counterfactualOwner) === eoa) {
      return {
        status: "block",
        reason: "the credential's own counterfactual Kernel is deployed and owned by it",
        userMessage: MSG_TAKEN,
      };
    }
  }

  // (3) Local traces of a previous life for this credential. A stored seed is the
  //     one that matters — it is the value the ceremony would destroy. `null` means
  //     the read itself failed, which is not evidence of absence.
  if (e.podSeedPresent === true) {
    return {
      status: "block",
      reason: "a POD seed is already stored under this credential",
      userMessage: MSG_TAKEN,
    };
  }
  if (e.podSeedPresent === null) {
    return {
      status: "block",
      reason: "could not read local identity storage",
      userMessage: MSG_UNSURE,
    };
  }
  if (cached && cached !== target) {
    return {
      status: "block",
      reason: `a previous login cached a different account for this credential (${cached})`,
      userMessage: MSG_TAKEN,
    };
  }

  // (4) Nothing local, and the chain could not be read. Absence is unproven in BOTH
  //     directions, and the binding this would write survives logout with no
  //     user-facing way to undo it — so refuse rather than write something sticky on
  //     a guess. Distinct message: "couldn't confirm", never "already taken".
  if (e.counterfactualOwner === "error") {
    return {
      status: "block",
      reason: "chain unreadable and no local evidence either way",
      userMessage: MSG_UNSURE,
    };
  }

  return { status: "allow", reason: "no account found for this credential" };
}
