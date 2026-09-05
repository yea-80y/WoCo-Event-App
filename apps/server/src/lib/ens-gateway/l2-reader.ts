/**
 * The gateway's only source of truth: an `eth_call` to the pinned L2Registry's
 * ENSIP-10 `resolve(bytes name, bytes data)`, which staticcalls `data` on itself
 * (the registry inherits ExtendedResolver) and returns the record bytes.
 *
 * A failure must PROPAGATE. Returning "0x" on an RPC error would have the
 * gateway sign "this record is unset" every time the RPC hiccups, and that
 * signature is cached and believed for the whole TTL.
 *
 * CROSS-CHECK (#465 §1). The gateway signs whatever this read returns, and that
 * signature IS resolution — a wrong `contenthash` is a silent site redirect,
 * valid for the TTL, indistinguishable on-chain from a real answer. With one
 * endpoint the RPC provider is therefore a fully trusted party. Reading the same
 * call from two unrelated providers and refusing to sign unless they agree
 * turns that into "two unrelated providers do not collude on the same lie",
 * for the cost of one extra `eth_call` per memo miss. Running our own Arbitrum
 * node is the stronger answer and remains out of scope.
 *
 * BOTH MUST ANSWER. An error on one provider is NOT "use the other one": that
 * would degrade to single-provider trust at exactly the moment something is
 * wrong, which is the moment an attacker would engineer — knock one provider
 * over, lie on the survivor. So a rejection anywhere is a refusal everywhere,
 * and the caller turns it into an unsigned 502.
 */
import { Interface, JsonRpcProvider, hexlify } from "ethers";
import type { ReadL2 } from "./ccip.js";

const RESOLVE_ABI = ["function resolve(bytes name, bytes data) view returns (bytes)"];
const RESOLVE_INTERFACE = new Interface(RESOLVE_ABI);

/** A CCIP-Read request holds an ENS client's connection open, so the RPC gets a hard ceiling. */
export const L2_READ_TIMEOUT_MS = 10_000;

/** Enough of a differing value to diagnose from, short enough not to flood the log. */
const LOG_VALUE_CHARS = 66;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * An RPC URL with its credentials removed.
 *
 * Provider URLs routinely carry the API key in the path or query
 * (`…/v2/<KEY>`, `?apikey=…`), so the raw URL is a secret and must never reach a
 * log line, an error message that might be logged, or /api/health. Origin only.
 */
export function redactRpcUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "<unparseable rpc url>";
  }
}

function truncate(hex: string): string {
  return hex.length <= LOG_VALUE_CHARS ? hex : `${hex.slice(0, LOG_VALUE_CHARS)}…(${hex.length} chars)`;
}

export interface L2ReaderDeps {
  /** Injectable so tests never open a socket. Receives the URL, returns a caller. */
  makeCall?: (url: string) => (tx: { to: string; data: string }) => Promise<string>;
  timeoutMs?: number;
}

/**
 * @param urls One or two endpoints for the SAME chain. Two enables the
 *   cross-check; one is the pre-#465 posture and is reported as
 *   `crossCheck: false` on /api/health rather than being silently equivalent.
 */
export function createL2Reader(chainId: number, urls: readonly string[], deps: L2ReaderDeps = {}): ReadL2 {
  if (urls.length === 0) throw new Error("createL2Reader: at least one RPC URL");
  // A tripwire, not input hygiene. The same URL twice would produce a green
  // cross-check that proves nothing at all — two reads of one provider agree by
  // construction — which is strictly worse than no cross-check, because an
  // operator would act on it. Config refuses this too; this is the second lock.
  if (new Set(urls).size !== urls.length) {
    throw new Error("createL2Reader: duplicate RPC URLs — a cross-check against itself proves nothing");
  }

  const timeoutMs = deps.timeoutMs ?? L2_READ_TIMEOUT_MS;
  const makeCall =
    deps.makeCall ??
    ((url: string) => {
      let provider: JsonRpcProvider | null = null;
      return (tx: { to: string; data: string }) => {
        provider ??= new JsonRpcProvider(url);
        return provider.call(tx);
      };
    });
  const callers = urls.map((url) => ({ url, call: makeCall(url) }));

  return async (registry, name, data) => {
    const calldata = RESOLVE_INTERFACE.encodeFunctionData("resolve", [hexlify(name), data]);

    // In parallel: a sequential pair would double the worst case, and a
    // CCIP-Read holds the ENS client's connection open for the whole of it.
    const settled = await Promise.allSettled(
      callers.map(({ url, call }) =>
        withTimeout(call({ to: registry, data: calldata }), timeoutMs, `L2 resolve on chain ${chainId} via ${redactRpcUrl(url)}`)
          .then((raw) => RESOLVE_INTERFACE.decodeFunctionResult("resolve", raw)[0] as string),
      ),
    );

    const failures = settled
      .map((s, i) => (s.status === "rejected" ? `${redactRpcUrl(callers[i]!.url)}: ${(s.reason as Error)?.message ?? s.reason}` : null))
      .filter((m): m is string => m !== null);
    if (failures.length > 0) {
      throw new Error(`L2 read failed on ${failures.length}/${callers.length} endpoint(s) — ${failures.join(" | ")}`);
    }

    const results = settled.map((s) => (s as PromiseFulfilledResult<string>).value);
    // Compare the value that will actually be SIGNED, not the raw frame: the
    // signed bytes are the whole of what a caller can be lied to about.
    //
    // The `toLowerCase` is belt, not the guard: ethers' decoder already emits
    // one canonical spelling, so there is no reachable case in which it changes
    // an answer — mutating it away breaks nothing, deliberately. The premise it
    // covers is pinned by "the ABI decoder normalises case" in the suite; if
    // that ever fails, this line is what stops a spelling difference from
    // reading as a forgery and taking every name down.
    const canonical = results.map((r) => r.toLowerCase());
    const disagreement = canonical.findIndex((r) => r !== canonical[0]);
    if (disagreement > 0) {
      throw new Error(
        "L2 endpoints disagree — refusing to sign. " +
          canonical
            .map((r, i) => `${redactRpcUrl(callers[i]!.url)} => ${truncate(r)}`)
            .join(" | "),
      );
    }

    return results[0]!;
  };
}
