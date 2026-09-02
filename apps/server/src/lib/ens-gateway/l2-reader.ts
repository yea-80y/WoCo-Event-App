/**
 * The gateway's only source of truth: an `eth_call` to the pinned L2Registry's
 * ENSIP-10 `resolve(bytes name, bytes data)`, which staticcalls `data` on itself
 * (the registry inherits ExtendedResolver) and returns the record bytes.
 *
 * A failure must PROPAGATE. Returning "0x" on an RPC error would have the
 * gateway sign "this record is unset" every time the RPC hiccups, and that
 * signature is cached and believed for the whole TTL.
 */
import { Interface, JsonRpcProvider, hexlify } from "ethers";
import { getChainRpcUrl } from "../chain/event-contract.js";
import type { ReadL2 } from "./ccip.js";

const RESOLVE_ABI = ["function resolve(bytes name, bytes data) view returns (bytes)"];
const RESOLVE_INTERFACE = new Interface(RESOLVE_ABI);

/** A CCIP-Read request holds an ENS client's connection open, so the RPC gets a hard ceiling. */
export const L2_READ_TIMEOUT_MS = 10_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export function readL2ViaRpc(chainId: number): ReadL2 {
  let provider: JsonRpcProvider | null = null;

  return async (registry, name, data) => {
    provider ??= new JsonRpcProvider(getChainRpcUrl(chainId));
    const calldata = RESOLVE_INTERFACE.encodeFunctionData("resolve", [hexlify(name), data]);
    const raw = await withTimeout(
      provider.call({ to: registry, data: calldata }),
      L2_READ_TIMEOUT_MS,
      `L2 resolve on chain ${chainId}`,
    );
    const [result] = RESOLVE_INTERFACE.decodeFunctionResult("resolve", raw);
    return result as string;
  };
}
