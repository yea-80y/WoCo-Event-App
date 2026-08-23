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
 * So this refuses at the FORWARD factory: an existing credential acquiring a second
 * account, on this device. Be precise about what that does and does not close —
 * two routes to the same collided state remain open, and a re-key migration author
 * who reads this as a guarantee will build on a false premise:
 *
 *  - REVERSED ORDER, same device. Recover onto a fresh credential (allowed, correctly
 *    — there is nothing to see), then later move that account to another credential.
 *    The first credential's binding is deleted by the stale-binding check on its next
 *    login, but its seed slot is NOT, and the session then falls through to that
 *    credential's own counterfactual account and adopts the leftover seed. Same
 *    silent wrong-identity end state, reached without this guard ever being consulted.
 *    Tracked separately; the fix is to clear the seed wherever the binding is cleared.
 *  - CROSS-DEVICE. Two recoveries onto the same credential on two devices. Neither
 *    device can see the other's, and no per-credential POINT read can either, because
 *    a recovered account lives at a PRESERVED address that is not derivable from the
 *    credential. CLOSED by #234: the validator's `OwnerRegistered` log, filtered on
 *    the credential and re-read live, is the authoritative owner→account record
 *    (`ownedAccountsScan` below, `owned-accounts-scan.ts`). What remains is the
 *    same-moment race, made loud by the tail re-scan after the rotation.
 *
 * STOPGAP, deliberately. The real fix is to key the binding by (ownerKey, account)
 * and the seed by (podAddress, parentAddress), so one key CAN own several accounts
 * and (2) becomes impossible rather than merely unreachable. This guard is a
 * prerequisite for that work — the migration must decide whose seed occupies a
 * legacy slot, and on an already-collided device that is unanswerable, since the
 * ciphertext and the AAD are identical either way. It narrows the population the
 * migration has to reason about; it does not empty it. Remove this guard only
 * together with that re-keying.
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
   * A binding this device previously VERIFIED on-chain for this credential. It
   * lives in localStorage, so it can outlive the IndexedDB binding when storage is
   * evicted unevenly — which is exactly the skew where every other local signal
   * reads clean and this one still remembers.
   */
  verifiedBinding?: string | null;
  /**
   * This EOA's own counterfactual Kernel address. Needed to tell "this credential
   * already has ANOTHER account" from "this credential already has THIS account" —
   * the latter is a legitimate recovery of your own never-recovered account, and
   * blocking it would tell a rightful holder to go and split their own account.
   */
  counterfactualAddress?: string | null;
  /**
   * On-chain owner of that counterfactual Kernel: an address when the chain
   * answered, `null` when it answered "no owner", `"error"` when it could not be
   * read. Absence proves nothing — Kernels deploy lazily, so a real account that
   * never transacted is invisible here. It is also structurally blind to RECOVERED
   * accounts, which live at preserved addresses no per-credential read can reach.
   */
  counterfactualOwner: string | null | "error";
  /**
   * The chain-log scan (#234, `owned-accounts-scan.ts`): every account this
   * credential was ever registered as owner of, re-read live. It is the ONLY
   * evidence that can see a RECOVERED account on another device — a preserved
   * address no per-credential point-read reaches. `undefined` = not run (the
   * caller runs it only after the cheaper evidence allows, since a full scan is
   * pages of `eth_getLogs`). `unknown` BLOCKS: the scan fails closed, with the
   * passkey route as the escape hatch.
   */
  ownedAccountsScan?:
    | { status: "clean" }
    | { status: "collision"; kernels: string[] }
    | { status: "unknown"; reason: string };
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
  const verified = lower(e.verifiedBinding);
  const counterfactual = lower(e.counterfactualAddress);

  // (0) IDEMPOTENT REPAIR — re-running recovery of the SAME account onto the SAME
  // credential must stay open. It is how a user recovers from a ceremony that died
  // partway, and it creates no collision: the slots it overwrites are already this
  // account's own. Checked first so no later rule can refuse a repair.
  if (binding && binding === target) {
    return { status: "allow", reason: "binding already points at this account — repair path" };
  }

  // (0b) RECOVERING YOUR OWN ACCOUNT ONTO ITS OWN CREDENTIAL. If the target IS this
  // credential's counterfactual, then the account it "already has" is the one being
  // recovered — there is no second account and nothing to alias. Blocking here would
  // tell a rightful holder that their own account belongs to someone else and advise
  // them to split it, which is worse than useless. Checked before the ownership rules
  // for the same reason as (0): a legitimate identity must not be refused by a rule
  // written to catch a different one.
  if (counterfactual && counterfactual === target) {
    return { status: "allow", reason: "the target IS this credential's own account" };
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

  // (2b) The cross-device evidence (#234): any account whose CURRENT owner is this
  //      credential, found from the validator's OwnerRegistered log. Structurally
  //      the only signal that sees a recovered account on another device.
  if (e.ownedAccountsScan?.status === "collision") {
    return {
      status: "block",
      reason: `the credential currently owns other account(s) on-chain (${e.ownedAccountsScan.kernels.join(", ")})`,
      userMessage: MSG_TAKEN,
    };
  }
  if (e.ownedAccountsScan?.status === "unknown") {
    return {
      status: "block",
      reason: `owned-accounts scan did not complete: ${e.ownedAccountsScan.reason}`,
      userMessage: MSG_UNSURE,
    };
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
  if (verified && verified !== target) {
    return {
      status: "block",
      reason: `this device previously verified a different account for this credential (${verified})`,
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
