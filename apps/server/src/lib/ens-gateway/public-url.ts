/**
 * The PUBLIC URL at which ENS clients (eth.limo among them) ask this gateway
 * for a name's contenthash — the same request `L1Resolver.url()` hands out:
 * `https://events-api.woco-net.com/api/ens-gateway/v1/{sender}/{data}` on
 * mainnet, checked 2026-09-21.
 *
 * It goes through Cloudflare and this gateway's memo exactly as an outside
 * resolver's request does, so its answer is what eth.limo will be told. That
 * is the point: the certificate warm-up waits for THIS answer to change before
 * it knocks (#557).
 *
 * Reads env directly rather than `loadEnsGatewayConfig`: that module imports
 * the sub-ENS contract module, which imports the warm-up, and the warm-up must
 * not close the loop.
 */

import { Interface, dnsEncode, namehash } from "ethers";

const STUFFED = new Interface(["function stuffedResolveCall(bytes,bytes,uint64,address)"]);
const CONTENTHASH = new Interface(["function contenthash(bytes32) view returns (bytes)"]);

type Env = Record<string, string | undefined>;

/**
 * The public gateway request for `name`'s contenthash on `registry`, or null
 * when this server is not configured to be reached that way (no public base
 * URL, or no L1 resolver it answers for).
 */
export function publicContenthashQueryUrl(
  name: string,
  chainId: number,
  registry: string,
  env: Env = process.env,
): string | null {
  const base = env.PUBLIC_API_BASE?.trim().replace(/\/+$/, "");
  // The first listed resolver; an entry may carry `:CHAINID` (L1Resolver v2).
  const sender = env.ENS_GATEWAY_RESOLVER_ADDRESSES?.split(",")
    .map((s) => s.trim().split(":")[0]!)
    .find((s) => s.length > 0);
  if (!base || !sender) return null;
  const inner = CONTENTHASH.encodeFunctionData("contenthash", [namehash(name)]);
  const data = STUFFED.encodeFunctionData("stuffedResolveCall", [dnsEncode(name), inner, BigInt(chainId), registry]);
  return `${base}/api/ens-gateway/v1/${sender}/${data}`;
}
