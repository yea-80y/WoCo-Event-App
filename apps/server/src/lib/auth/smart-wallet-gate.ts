/**
 * Which authority decides a parent signature (#209).
 *
 * A session delegation is accepted if either of two verification paths
 * validates. They do not answer with the same authority:
 *
 *   Path 1  ecrecover, then `isKernelOwner` — reads the account's CURRENT
 *           on-chain owner, and records the account in the kernel-deployed
 *           store when it finds one.
 *   Path 2  `verifySmartWalletTypedData` — an ERC-1271/6492 verification run
 *           across candidate chains, accepting if ANY validates.
 *
 * A 6492 wrapper may embed the account's original factory init data. On a chain
 * serving pre-deployment state for that address, the universal validator
 * simulates the original deployment and validates against the ORIGINAL owner —
 * an owner Path 1 would refuse once the account has rotated.
 *
 * That is not a lagging-node edge case. WoCo Kernels are deployed on Arbitrum
 * Sepolia only, so every OTHER candidate chain serves permanent, honest
 * pre-deployment state for the same address, and the factories deploy
 * deterministically cross-chain. Path 2 must therefore be skipped entirely for
 * accounts we can identify, not merely narrowed to fewer chains.
 *
 * Two residuals are accepted deliberately:
 *
 *  - A Coinbase Smart Wallet cannot land in the store by accident: the only
 *    writer marks on a non-zero read from the ZeroDev ECDSA validator, whose
 *    storage is keyed by `msg.sender`. An owner could only self-poison their own
 *    entry, and the result is a denial of their own Path 2 — never an admission.
 *  - A rotated-out CSW owner replaying 6492 on a chain where that CSW is
 *    undeployed is the symmetric case, and is out of scope: WoCo has no CSW
 *    owner-rotation flow, and this store neither can nor should cover CSW.
 */

export type SmartWalletPathDecision =
  | { attempt: true }
  | { attempt: false; reason: string };

/**
 * Decide whether the smart-wallet path may run for this parent.
 *
 * Split from the caller so the truth table can be pinned without a live chain or
 * a live verifier — the same reason `decideKernelOwnership` is a pure function.
 * A gate that only exists inline is one whose entire hunk can be reverted with
 * the suite still green.
 *
 * @param knownDeployed  the store's memory: this account HAS been observed with
 *                       an on-chain owner at some point.
 * @param liveOwner      the authority itself, tri-state: an address means it has
 *                       an owner now; `null` means provably none; `"error"`
 *                       means the read failed and decides nothing.
 */
export function decideSmartWalletPath(args: {
  knownDeployed: boolean;
  liveOwner: string | null | "error";
}): SmartWalletPathDecision {
  // The store's memory is enough on its own. Consulted first so the common case
  // costs no chain read.
  if (args.knownDeployed) {
    return { attempt: false, reason: "account has been observed with an on-chain owner" };
  }

  // Memory alone leaves a window: an account that was deployed and rotated but
  // has not since completed a Path 1 verification is deployed-yet-unmarked, and
  // that is the FRESHEST instance of the account this gate protects. So ask the
  // authority, not only its memory.
  if (args.liveOwner !== null && args.liveOwner !== "error") {
    return { attempt: false, reason: "on-chain owner read live for this account" };
  }

  // `"error"` deliberately does NOT refuse here, and that is not an oversight.
  // An unreadable chain must not brick every smart-wallet login; the store
  // remains the decider in that case, and it fails open by the same reasoning
  // recorded in kernel-deployed.ts — refusing every account over a transient
  // read trades a narrow window for a broad outage. Note the asymmetry with
  // `decideKernelOwnership`, where an RPC unknown fails CLOSED for a
  // known-deployed account: there, refusing costs one caller a retry; here it
  // would cost every Coinbase Smart Wallet user their session.
  return { attempt: true };
}
