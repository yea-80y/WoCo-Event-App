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
 * matching `/chain/42161` segment AND `?selfFunded=true` (managed sponsorship
 * is testnet-only on the free plan; the query routes to WoCo's own deposited
 * paymaster), and `kernel-deployed.json` sightings from the old chain must stop
 * counting — every Kernel is counterfactual again on day one (#200). See
 * issue #489 for the full checklist.
 */
export const KERNEL_CHAIN_ID = 42161 as const;

/** The literal above as a type, so a map over it is exhaustive by the compiler. */
export type KernelChainId = typeof KERNEL_CHAIN_ID;

/**
 * ERC-4337 EntryPoint v0.7 — the same address on every chain it is deployed to.
 *
 * Only ever READ from here: `balanceOf(paymaster)` is the paymaster's deposit,
 * which is what actually pays for a userOp. Shared rather than server-local
 * because it is a property of the account-abstraction stack the client builds
 * for, not of the health endpoint that happens to watch it today.
 */
export const ENTRY_POINT_V07_ADDRESS = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;

/**
 * WoCo's self-funded ZeroDev Sponsorship Paymaster on {@link KERNEL_CHAIN_ID}.
 *
 * WHY IT IS WATCHED. Every Kernel userOp — recovery setup, add/remove backup,
 * name discard, a guardian's recovery — is paid for by this paymaster's
 * EntryPoint deposit, and the ops go client → ZeroDev without the server ever
 * seeing one. When the deposit empties, each of them fails with the cliff-guard
 * "temporarily unavailable" and nothing on our side would otherwise notice
 * (#522). The deposit is a public read, so the server can watch it even though
 * it cannot see the ops.
 *
 * NOT the ZeroDev monthly policy caps (sponsored gas and ops per month): those
 * are dashboard-only. Two ceilings, one visible here.
 */
export const SELF_FUNDED_PAYMASTER_ADDRESS = "0xc99c11AD232a24e1158156b1F46495Cc8069c08f" as const;
