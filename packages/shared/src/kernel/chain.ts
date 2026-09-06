/**
 * The chain WoCo's ZeroDev Kernel smart accounts (passkey + web3auth logins)
 * live on — Arbitrum One (#489).
 *
 * WHY IT IS SHARED. The client builds and signs for the Kernel; the server
 * decides whether a recovered EOA owns it, and reads the chain to find out.
 * Those two pins used to be separate literals in separate workspaces with no
 * compiler relationship — the exact shape that let the sub-ENS registrar
 * addresses drift for months (#472). One exported constant makes a
 * disagreement impossible rather than merely unlikely.
 *
 * WHY 42161. Sub-ENS names moved to Arbitrum One first
 * ({@link SUB_ENS_DEFAULT_CHAIN_ID}), and a name minted for an account that
 * lives on another chain is a name its owner cannot prove control of from the
 * chain the registry is on: the registrar's EIP-712 domain and the Kernel's
 * ERC-1271 answer have to be on the same chain for a release to verify.
 * `test/kernel/chain.test.ts` pins that agreement.
 *
 * WHY THIS IS NOT THE WHOLE FLIP. Moving the Kernel is a ZeroDev PROJECT
 * change, not a constant: `ZERODEV_RPC` / `VITE_ZERODEV_RPC` must carry the
 * matching `/chain/42161` segment, the paymaster policy must exist on that
 * project, and `kernel-deployed.json` sightings from the old chain must stop
 * counting — every Kernel is counterfactual again on day one (#200). See
 * issue #489 for the full checklist.
 */
export const KERNEL_CHAIN_ID = 42161 as const;

/** The literal above as a type, so a map over it is exhaustive by the compiler. */
export type KernelChainId = typeof KERNEL_CHAIN_ID;
