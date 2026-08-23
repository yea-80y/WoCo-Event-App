/**
 * Pairing rule for a cold Web3Auth restore (#183): the live SDK session and the
 * stored WoCo identity must belong to the SAME person before they are joined.
 *
 * `init()` used to take the private key from the live Web3Auth session and the
 * parent / POD address from local storage, and pair them with no check that they
 * matched — while the coinbase branch thirty lines below checks
 * `session.address === storedParent`. The reachable precondition is a sign-out
 * that half-completed on a shared device: user A's `PARENT_ADDRESS` / `POD_ADDRESS`
 * survive, user B signs in, and the next page load would adopt A's identity with
 * B's key — then `_establishFeedSignerEagerly` derives A's content-feed signer
 * from B's key and persists it under A's parent, forking A's feeds before any
 * later check (`requestSessionDelegation`'s signer comparison) could fire.
 *
 * Pure, dependency-free, so the matrix is tested rather than eyeballed. The
 * address the SDK returns IS the Web3Auth EOA, which is what `POD_ADDRESS`
 * stores for this kind (invariant #1 in `init`), so that is the pair compared.
 */

/** Mirror of `Web3AuthRestore` (web3auth-account.ts), kept structural so this
 *  module needs no SDK import. */
export type RestoreLike =
  | { status: "restored"; address: string; privateKey: string }
  | { status: "expired" }
  | { status: "unavailable" };

export type Web3AuthRestoreDecision =
  /** Live session and stored identity agree: adopt both, key in hand. */
  | { action: "adopt"; privateKey: string }
  /** SDK could not answer (transient): keep the stored session, no key yet,
   *  retry in the background — and re-run THIS check when the retry lands. */
  | { action: "adopt-without-key" }
  /** Do not adopt. `identity-mismatch` is the #183 case: a different person is
   *  signed in to Web3Auth than the one this device's storage names. */
  | { action: "clear"; reason: "no-identity" | "expired" | "identity-mismatch" };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function decideWeb3AuthRestore(args: {
  restore: RestoreLike;
  storedParent: string | null | undefined;
  storedPodAddr: string | null | undefined;
}): Web3AuthRestoreDecision {
  const { restore, storedParent, storedPodAddr } = args;
  // Missing POD_ADDRESS = a pre-Kernel-upgrade session (parent was the raw EOA);
  // missing PARENT = nothing to restore. Both force a clean re-login.
  if (!storedParent || !storedPodAddr) return { action: "clear", reason: "no-identity" };
  if (restore.status === "expired") return { action: "clear", reason: "expired" };
  if (restore.status === "unavailable") return { action: "adopt-without-key" };
  if (!restore.address || !same(restore.address, storedPodAddr)) {
    return { action: "clear", reason: "identity-mismatch" };
  }
  return { action: "adopt", privateKey: restore.privateKey };
}

/**
 * The same rule for the BACKGROUND key retry after an `adopt-without-key`: the
 * key that finally arrives must belong to the identity already adopted, or the
 * mismatch the boot check refused would be reintroduced asynchronously.
 */
export type Web3AuthKeyRetryDecision =
  | { action: "adopt"; privateKey: string }
  | { action: "clear" }
  | { action: "stop" }
  | { action: "retry" };

export function decideWeb3AuthKeyRetry(args: {
  restore: RestoreLike;
  /** The POD (Web3Auth EOA) address the boot path adopted without a key. */
  adoptedPodAddr: string | null | undefined;
}): Web3AuthKeyRetryDecision {
  const { restore, adoptedPodAddr } = args;
  if (restore.status === "unavailable") return { action: "retry" };
  if (restore.status === "expired") return { action: "stop" };
  if (!adoptedPodAddr || !restore.address || !same(restore.address, adoptedPodAddr)) return { action: "clear" };
  return { action: "adopt", privateKey: restore.privateKey };
}
