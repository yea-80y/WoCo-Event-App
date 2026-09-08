/**
 * Which rails can burn a name for THIS login, and whether to offer it at all.
 *
 * `releaseWithSignature` verifies the holder's signature through the ERC-6492
 * universal validator (`L2Registry.sol`): a signature from an address with no
 * code on the name's chain is checked by `ecrecover`, so it only ever passes
 * for a plain EOA holder. That single fact decides everything here.
 *
 * WHO HOLDS THE NAME. The server mints to the VERIFIED `parentAddress`, so the
 * holder is whatever `auth.parent` is for that login kind:
 *
 *   web3      → the user's own EOA. ecrecover passes. Relay (sponsor pays) with
 *               an own-gas `release()` behind it.
 *   web3auth  → a ZeroDev KERNEL, not the Web3Auth EOA. `auth-store.svelte.ts`
 *               is explicit: "The Kernel address (not the EOA) becomes the
 *               parent identity". The raw key's signature recovers to the EOA,
 *               which is not the holder, so the relay reverts `Unauthorized`.
 *               ⚠️ This CONTRADICTS the step-9 design note that filed web3auth
 *               with web3 as an "EOA login" — verified 2026-09-06 by reading
 *               the login path, and treated as an AA kind here for exactly the
 *               reason passkey is.
 *   passkey   → a ZeroDev Kernel.
 *   coinbase  → a Coinbase Smart Wallet (ERC-1271/6492, per its own module
 *               header). Not a Kernel, but a contract account all the same.
 *
 * A contract holder needs ERC-1271, which needs the account to EXIST on the
 * name's chain. The names live on Arbitrum One while the Kernel still runs on
 * Arbitrum Sepolia (#489), so today no AA login can release. The gate is that
 * comparison rather than a flag: when the Kernel moves, this switches itself on
 * and nothing has to be remembered. (`KERNEL_CHAIN_ID` is the proxy for
 * "the smart account exists on the name chain" for Coinbase too — it is the one
 * date on which AA signing becomes checkable at all.)
 *
 * Pure: chain ids are ARGUMENTS, so the caller owns the constants and #489's
 * flip stays a one-line change at the call site.
 */

import type { AuthKind } from "@woco/shared";

export type ReleaseRail = "relay" | "wallet" | "kernel";

export interface ReleaseRailPlan {
  /** May this login discard a name at all right now? */
  available: boolean;
  /** Rails to try, in order. Empty when unavailable. */
  rails: ReleaseRail[];
  /** Why not, as a sentence — present only when unavailable. */
  reason?: string;
}

/** Shown when the holder is a smart account that does not exist on the name's chain. */
const AA_PENDING =
  "Discarding a name from this account arrives with the Arbitrum One account move — the name stays yours.";

export function releaseRails(
  kind: AuthKind,
  kernelChainId: number,
  nameChainId: number,
): ReleaseRailPlan {
  switch (kind) {
    // The only holder the registry can check by ecrecover today.
    case "web3":
      return { available: true, rails: ["relay", "wallet"] };

    case "passkey":
    case "coinbase":
    case "web3auth":
      return kernelChainId === nameChainId
        ? { available: true, rails: ["relay", "kernel"] }
        : { available: false, rails: [], reason: AA_PENDING };

    case "none":
      return { available: false, rails: [], reason: "Sign in to manage your names." };

    // Declared in AuthKind, never implemented (no ed25519 adapter). Refuse
    // rather than assume a signing shape that does not exist.
    case "zupass":
      return { available: false, rails: [], reason: "This sign-in method can't discard a name." };
  }
}
