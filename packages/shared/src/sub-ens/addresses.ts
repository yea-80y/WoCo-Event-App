/**
 * Sub-ENS contract addresses, per chain — the single source of truth for both
 * workspaces (#472).
 *
 * These two addresses MUST agree across the server and the client, and they
 * have no compiler relationship when each side keeps its own copy: the server
 * signs a `RegisterPermit` whose EIP-712 domain binds the registrar's own
 * address, and the client scopes a ZeroDev session key to call exactly that
 * registrar. If the copies drift, every gasless mint is refused by the
 * permission validator and silently degrades to the sponsor path. They HAD
 * drifted for months before the 2026-09-02 flip (server `0x206e…BEd3`,
 * client `0x7c0D…aAf1`), papered over by env. A test that scraped one file's
 * source as text guarded it in the meantime; this module replaces it with the
 * compiler.
 *
 * The two layers are deliberately separate:
 *  - `registry`  — L2Registry, the PERMANENT layer. It holds every name as an
 *    ERC-721 and carries the resolver records. Replacing it is a migration of
 *    every holder, every follow target and every ENS pointer, so it is treated
 *    as frozen from the mainnet deploy onward.
 *  - `registrar` — WoCoRegistrar, the REPLACEABLE policy layer: who may mint,
 *    the rate cap, the permit scheme. Swapping it costs a `addRegistrar` call.
 */

import type { Hex0x } from "../types.js";

export interface SubEnsDeployment {
  /** L2Registry (ERC-721 + resolver records) — EIP-1167 clone of our own impl. */
  registry: Hex0x;
  /** WoCoRegistrar — the mint door the sponsor and the permit rail both go through. */
  registrar: Hex0x;
}

/**
 * Arbitrum Sepolia (421614) — redeployed 2026-09-03 from OUR L2Registry
 * implementation (`0xc12aA209…2c7a`), so the registry carries #422
 * `adminTransfer` and #464 `release` + `releaseWithSignature`. The 2026-09-02
 * pair (`0x6a52…9b22` / `0xD33C…7816`, zero user names) and the NameStone
 * factory clones before it (`0x41Fb…4807` / `0x206e…BEd3` / `0x7c0D…aAf1`, 23
 * test names) are abandoned — names do not carry across a registry, so every
 * label is claimable from scratch here.
 *
 * Deployment record: `contracts/deployments/421614-subens.json` in the
 * WoCo-Contracts repo.
 *
 * Arbitrum One (42161) — pending the mainnet deploy (plan steps 7–9). Adding
 * that row is the whole change on this side; nothing else hardcodes an address.
 */
export const SUB_ENS_DEPLOYMENTS = {
  421614: {
    registry: "0xC38e08CB5a21B083F63149ea7597Ea8D05017cf8",
    registrar: "0x42c6464d65e79C4735A0b346d1c1b4690586d6F9",
  },
} as const satisfies Record<number, SubEnsDeployment>;

/** Chains this build knows sub-ENS addresses for — a compile-time union. */
export type SubEnsChainId = keyof typeof SUB_ENS_DEPLOYMENTS;

/**
 * The chain sub-ENS runs on unless the server's `SUB_ENS_CHAIN_ID` says
 * otherwise. The client has no env of its own here: it indexes
 * {@link SUB_ENS_DEPLOYMENTS} by a literal chain id, so an unknown chain is a
 * type error rather than an `undefined` address reaching a contract call.
 */
export const SUB_ENS_DEFAULT_CHAIN_ID = 421614 satisfies SubEnsChainId;

/**
 * Runtime lookup for the server, whose chain id arrives as a plain number from
 * env. Throws rather than returning `undefined` — a missing deployment must
 * fail loudly at the call site, not become an `undefined` in calldata.
 */
export function getSubEnsDeployment(chainId: number): SubEnsDeployment {
  const deployment = (SUB_ENS_DEPLOYMENTS as Record<number, SubEnsDeployment | undefined>)[chainId];
  if (!deployment) throw new Error(`No sub-ENS deployment for chain ${chainId}`);
  return deployment;
}
