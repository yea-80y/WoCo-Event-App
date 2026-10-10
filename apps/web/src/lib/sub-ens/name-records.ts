/**
 * What the chain says about a handful of WoCo names: who holds each, and
 * whether it points anywhere. One batched read against the registry, straight
 * from the browser, so the share sheet never asks the server whose names are
 * whose.
 *
 * "Points anywhere" gates using a name as a web address. A name with no
 * contenthash fails its certificate on first visit and burns that hostname's
 * retry budget (see `sub-ens/web.ts` in `@woco/shared`), so a code must not
 * carry one until the chain shows it set.
 */

import { SUB_ENS_DEPLOYMENTS, subEnsName, type SubEnsChainId } from "@woco/shared";
import type { Chain } from "viem";
// Named imports: the whole-module dynamic form pulls every chain definition in.
import { arbitrum, arbitrumSepolia } from "viem/chains";
import { SUB_ENS_CHAIN_ID, subEnsRpcUrl } from "./rpc.js";

export interface NameRecord {
  label: string;
  /** Lowercased holder, or null when the name is not registered. */
  owner: string | null;
  /** True when the name has a contenthash, so its web address loads something. */
  points: boolean;
}

/** One call's outcome, as a multicall with `allowFailure` reports it. */
export type CallResult<T> = { status: "success"; result: T } | { status: "failure" };

export interface RawRecord {
  owner: CallResult<string>;
  contenthash: CallResult<string>;
}

/** Raw results for `labels`, in order. Throws when the read as a whole failed. */
export type ReadRaw = (labels: readonly string[]) => Promise<RawRecord[]>;

/**
 * Records for `labels`, each asked once in lower case, or null when the chain
 * could not be read. Null is not "nobody holds these": callers show no name.
 */
export async function readNameRecords(
  labels: readonly string[],
  read: ReadRaw = liveRead,
): Promise<NameRecord[] | null> {
  const unique = [...new Set(labels.map((l) => l.toLowerCase()))];
  if (unique.length === 0) return [];
  let raw: RawRecord[];
  try {
    raw = await read(unique);
  } catch {
    return null;
  }
  if (raw.length !== unique.length) return null;
  return unique.map((label, i) => ({
    label,
    // `ownerOf` reverts only for a token that does not exist: never minted, or released.
    owner: raw[i]!.owner.status === "success" ? raw[i]!.owner.result.toLowerCase() : null,
    // An unreadable contenthash offers no address rather than one that may not load.
    points: raw[i]!.contenthash.status === "success" && raw[i]!.contenthash.result.length > 2,
  }));
}

const CHAINS = {
  42161: arbitrum,
  421614: arbitrumSepolia,
} as const satisfies Record<SubEnsChainId, Chain>;

const REGISTRY_ABI = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "contenthash",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "", type: "bytes" }],
  },
] as const;

const liveRead: ReadRaw = async (labels) => {
  const { createPublicClient, http, namehash } = await import("viem");
  const client = createPublicClient({
    chain: CHAINS[SUB_ENS_CHAIN_ID],
    transport: http(subEnsRpcUrl(), { timeout: 15_000 }),
  });
  const registry = SUB_ENS_DEPLOYMENTS[SUB_ENS_CHAIN_ID].registry;
  // The token id IS the node, as the registry and the server both derive it.
  const nodes = labels.map((label) => namehash(subEnsName(label)));
  const results = await client.multicall({
    allowFailure: true,
    contracts: nodes.flatMap((node) => [
      { address: registry, abi: REGISTRY_ABI, functionName: "ownerOf", args: [BigInt(node)] } as const,
      { address: registry, abi: REGISTRY_ABI, functionName: "contenthash", args: [node] } as const,
    ]),
  });
  return nodes.map((_, i) => ({
    owner: results[2 * i] as unknown as CallResult<string>,
    contenthash: results[2 * i + 1] as unknown as CallResult<string>,
  }));
};
