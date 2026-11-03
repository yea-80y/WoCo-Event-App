/**
 * Multicall3 `aggregate3` by hand, for browser pages that must not carry viem (the
 * seat map in the app, on organisers' websites and in the embed). One `eth_call`
 * runs many view calls; each answers on its own (`allowFailure: true`).
 *
 * Only fixed-shape views go through here: a caller names the exact byte length it
 * expects back, and anything else - a failed call, a short or long answer - is
 * "unknown", never a default value. Golden vectors: test/chain/multicall.test.ts;
 * the same bytes are checked against viem in apps/web/test.
 */

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/** Canonical Multicall3, immutable and at one address on every chain it is on. */
export const MULTICALL3_ADDRESS = "0xca11bde05977b3631167028862be2a173976ca11";

/** `aggregate3((address,bool,bytes)[])`. */
const AGGREGATE3 = "82ad56cb";

/** Arbitrum's ArbSys precompile: `arbBlockNumber()` is the L2 block (Multicall3's `getBlockNumber` is L1's there). */
export const ARBSYS_ADDRESS = "0x0000000000000000000000000000000000000064";
export const ARB_BLOCK_NUMBER = "0xa3b1b31d";

export interface ViewCall {
  /** 0x + 40 hex. */
  target: string;
  /** 0x + selector + arguments. */
  data: string;
}

const strip = (h: string) => (h.startsWith("0x") || h.startsWith("0X") ? h.slice(2) : h).toLowerCase();
const word = (n: number | bigint) => BigInt(n).toString(16).padStart(64, "0");
const HEX_RE = /^[0-9a-f]*$/;

/** A 32-byte word: an address (left-padded), a bytes32 or a uint. */
export function abiWord(v: string | number | bigint): string {
  if (typeof v === "string") {
    const h = strip(v);
    if (!HEX_RE.test(h) || h.length > 64 || h.length % 2) throw new Error("not a hex word");
    return h.length === 64 ? h : h.padStart(64, "0");
  }
  if (BigInt(v) < 0n || BigInt(v) >= 1n << 256n) throw new RangeError("uint out of range");
  return word(v);
}

/** Calldata for `selector(args...)` where every argument is one static word. */
export function staticCall(selector: string, ...args: (string | number | bigint)[]): string {
  const s = strip(selector);
  if (!/^[0-9a-f]{8}$/.test(s)) throw new Error("bad selector");
  return `0x${s}${args.map(abiWord).join("")}`;
}

/** `aggregate3` calldata, every call with `allowFailure = true`. */
export function encodeAggregate3(calls: readonly ViewCall[]): string {
  const tuples = calls.map((c) => {
    const target = strip(c.target);
    if (!/^[0-9a-f]{40}$/.test(target)) throw new Error("bad target");
    const data = strip(c.data);
    if (!HEX_RE.test(data) || data.length % 2) throw new Error("bad calldata");
    const len = data.length / 2;
    const padded = data.padEnd(Math.ceil(len / 32) * 64, "0");
    // (address target, bool allowFailure, bytes callData): the bytes sit after three head words.
    return target.padStart(64, "0") + word(1) + word(0x60) + word(len) + padded;
  });
  let offset = 32 * tuples.length;
  const offsets: string[] = [];
  for (const t of tuples) {
    offsets.push(word(offset));
    offset += t.length / 2;
  }
  return `0x${AGGREGATE3}${word(0x20)}${word(tuples.length)}${offsets.join("")}${tuples.join("")}`;
}

/** One call's answer: its bytes, or null when it failed or did not answer in the expected shape. */
export type CallResult = Uint8Array | null;

/**
 * Decode `aggregate3`'s `(bool success, bytes returnData)[]`. `expect[i]` is the exact
 * length call i must return. Throws only when the outer answer is not an aggregate3
 * answer for this many calls (the read as a whole failed).
 */
export function decodeAggregate3(hex: string, expect: readonly number[]): CallResult[] {
  const h = strip(hex);
  if (!HEX_RE.test(h) || h.length % 64) throw new Error("not an aggregate3 answer");
  const b = hexToBytes(h);
  const u = (at: number): number => {
    if (at < 0 || at + 32 > b.length) throw new Error("aggregate3 answer is short");
    for (let i = at; i < at + 24; i++) if (b[i] !== 0) throw new Error("aggregate3 offset out of range");
    let n = 0;
    for (let i = at + 24; i < at + 32; i++) n = n * 256 + b[i];
    if (!Number.isSafeInteger(n)) throw new Error("aggregate3 offset out of range");
    return n;
  };
  const arr = u(0);
  const n = u(arr);
  if (n !== expect.length) throw new Error("aggregate3 answered a different number of calls");
  const base = arr + 32;
  return expect.map((want, i) => {
    const t = base + u(base + 32 * i);
    const success = u(t);
    if (success !== 1) return null;
    const at = t + u(t + 32);
    const len = u(at);
    if (len !== want || at + 32 + len > b.length) return null;
    return b.slice(at + 32, at + 32 + len);
  });
}

/** Word `i` of a call's answer as an unsigned integer. */
export function uintAt(data: Uint8Array, i: number): bigint {
  let v = 0n;
  for (let k = i * 32; k < i * 32 + 32; k++) v = (v << 8n) | BigInt(data[k]);
  return v;
}

/** Word `i` as a bool: exactly 0 or 1, anything else is null. */
export function boolAt(data: Uint8Array, i: number): boolean | null {
  const v = uintAt(data, i);
  return v === 0n ? false : v === 1n ? true : null;
}

/** Word `i` as 0x + 64 hex (a bytes32). */
export const bytes32At = (data: Uint8Array, i: number): string => `0x${bytesToHex(data.slice(i * 32, i * 32 + 32))}`;

/** The chain refused, or the RPC said slow down: a reader backs off and shows "can't check right now". */
export class RpcError extends Error {
  constructor(message: string, readonly rateLimited = false) {
    super(message);
    this.name = "RpcError";
  }
}

let rpcId = 0;

/** `eth_call` at latest, returning the result hex. */
export async function ethCall(rpcUrl: string, call: ViewCall, doFetch: typeof fetch = fetch, signal?: AbortSignal): Promise<string> {
  let resp: Response;
  try {
    resp = await doFetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "eth_call", params: [{ to: call.target, data: call.data }, "latest"] }),
      signal,
    });
  } catch (err) {
    throw new RpcError(`chain read failed: ${String(err)}`);
  }
  if (resp.status === 429) throw new RpcError("rate limited", true);
  if (!resp.ok) throw new RpcError(`chain read failed (HTTP ${resp.status})`);
  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    throw new RpcError("chain read answered with something other than JSON");
  }
  const r = body as { result?: unknown; error?: { code?: number; message?: string } };
  if (r.error) throw new RpcError(`chain read refused: ${r.error.message ?? "error"}`, r.error.code === -32005 || r.error.code === 429);
  if (typeof r.result !== "string") throw new RpcError("chain read answered without a result");
  return r.result;
}

/** Run `calls` through Multicall3 in one eth_call. */
export async function multicall(
  rpcUrl: string,
  calls: readonly ViewCall[],
  expect: readonly number[],
  doFetch: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<CallResult[]> {
  const hex = await ethCall(rpcUrl, { target: MULTICALL3_ADDRESS, data: encodeAggregate3(calls) }, doFetch, signal);
  return decodeAggregate3(hex, expect);
}
