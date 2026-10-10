/**
 * The RPC every browser-side read of the name registry goes through.
 *
 * NEVER `VITE_ZERODEV_RPC`: that is the Kernel's bundler RPC on the Kernel's
 * chain, and pointing a registry read at it answers "nobody owns this" for names
 * that plainly exist. Keyed by {@link SubEnsChainId} so adding a deployment
 * without an RPC fails the build rather than at a holder's release. An origin
 * added here must also be in the CSP `connect-src` list
 * (`apps/web/vite-plugins/csp.ts`) or the browser blocks it.
 *
 * The chain is the sub-ENS constant's, not the Kernel's. They were apart for a
 * release cycle, and reading from the Kernel's chain then queried a registry
 * where the holder owns nothing. The equality is asserted in
 * `packages/shared/test/kernel/chain.test.ts`, not assumed here.
 */

import { SUB_ENS_DEFAULT_CHAIN_ID, type SubEnsChainId } from "@woco/shared";
import { buildEnv } from "../build-env.js";

export const SUB_ENS_CHAIN_ID: SubEnsChainId = SUB_ENS_DEFAULT_CHAIN_ID;

const PUBLIC_RPC: Record<SubEnsChainId, string> = {
  42161: "https://arb1.arbitrum.io/rpc",
  421614: "https://sepolia-rollup.arbitrum.io/rpc",
};

export function subEnsRpcUrl(): string {
  const override = buildEnv(() => import.meta.env.VITE_SUB_ENS_RPC as string | undefined)?.trim();
  if (override) return override;
  const url: string | undefined = PUBLIC_RPC[SUB_ENS_CHAIN_ID];
  if (!url) throw new Error(`No sub-ENS RPC for chain ${SUB_ENS_CHAIN_ID}`);
  return url;
}
