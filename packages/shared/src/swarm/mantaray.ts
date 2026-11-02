/**
 * The smallest Swarm manifest (mantaray v0.2) codec a site publish needs (#1032):
 * read a node's fork records, and write nodes in the exact layout bee itself
 * writes for a `/bzz` upload, so a site built here is the manifest bee would have
 * built from the same files. Deliberately not a general mantaray library: no
 * obfuscation (bee uses a zero key for unencrypted manifests and so do we), no
 * path splitting (callers lay out prefixes), no tree walking.
 *
 * Node:  key(32, zero) | version hash(31) | ref size(1) | entry(ref size) | fork bitmap(32) | forks
 * Fork:  type(1) | prefix length(1) | prefix(30, zero padded) | child node address(32) | [metadata]
 * Metadata: length(2, BE) | JSON | "\n" padding, with n = 2 + JSON length: bee
 * pads to 32 when n < 32, nothing when n is exactly 32, and 32 - n % 32 when
 * n > 32 (a full 32 at 64, 96...; bee-js pads none there; both read either).
 * Go's JSON also sorts keys and escapes <, > and &: the metadata written here is
 * fixed content types and file names, which have none.
 */

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { bytesTreeRoot } from "./bytes-tree.js";

/** keccak256("mantaray:0.2"), first 31 bytes. */
const VERSION_02_HASH = hexToBytes("5768b3b6a7db56d21d1abff40d41cebfc83448fed8d7e9b06ec0d3b073f28f");
const REF_BYTES = 32;
const PREFIX_MAX = 30;
const FORK_FIXED = 2 + PREFIX_MAX + REF_BYTES;

export const MANTARAY_TYPE_VALUE = 2;
export const MANTARAY_TYPE_EDGE = 4;
export const MANTARAY_TYPE_PATH_SEPARATOR = 8;
export const MANTARAY_TYPE_METADATA = 16;

/** One fork exactly as a node stores it; `record` is its full encoding, metadata included. */
export interface MantarayFork {
  type: number;
  prefix: string;
  /** Child node address, 64 hex. */
  ref: string;
  metadata?: Record<string, string>;
  record: Uint8Array;
}

export interface MantarayNodeView {
  /** The node's own entry (64 hex), or null when it has none (all zero). */
  entry: string | null;
  forks: MantarayFork[];
}

/** Parse one node's bytes. Throws on anything but a zero-key v0.2 node with 32-byte refs. */
export function parseMantarayNode(data: Uint8Array): MantarayNodeView {
  if (data.length < 64 + 1 + 32) throw new Error("mantaray: node too short");
  if (data.subarray(0, 32).some((b) => b !== 0)) throw new Error("mantaray: obfuscated node");
  for (let i = 0; i < 31; i++) if (data[32 + i] !== VERSION_02_HASH[i]) throw new Error("mantaray: not a v0.2 node");
  // Fork records assume 32-byte references, so a node of any other size would misparse.
  const refSize = data[63]!;
  if (refSize !== REF_BYTES) throw new Error("mantaray: unsupported ref size");
  let pos = 64;
  const entryBytes = data.subarray(pos, pos + refSize);
  pos += refSize;
  const entry = entryBytes.some((b) => b !== 0) ? bytesToHex(entryBytes) : null;
  const bitmap = data.subarray(pos, pos + 32);
  pos += 32;
  const forks: MantarayFork[] = [];
  for (let i = 0; i < 256; i++) {
    if (!((bitmap[i >> 3]! >> (i & 7)) & 1)) continue;
    const start = pos;
    if (pos + FORK_FIXED > data.length) throw new Error("mantaray: truncated fork");
    const type = data[pos]!;
    const len = data[pos + 1]!;
    if (len < 1 || len > PREFIX_MAX) throw new Error("mantaray: bad prefix length");
    const prefixBytes = data.subarray(pos + 2, pos + 2 + len);
    if (prefixBytes[0] !== i) throw new Error("mantaray: fork filed under the wrong byte");
    const prefix = new TextDecoder("utf-8", { fatal: true }).decode(prefixBytes);
    const ref = bytesToHex(data.subarray(pos + 2 + PREFIX_MAX, pos + FORK_FIXED));
    pos += FORK_FIXED;
    let metadata: Record<string, string> | undefined;
    if (type & MANTARAY_TYPE_METADATA) {
      if (pos + 2 > data.length) throw new Error("mantaray: truncated metadata");
      const mlen = (data[pos]! << 8) | data[pos + 1]!;
      if (pos + 2 + mlen > data.length) throw new Error("mantaray: truncated metadata");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(pos + 2, pos + 2 + mlen));
      const parsed: unknown = JSON.parse(text.replace(/\n+$/, ""));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("mantaray: bad metadata");
      metadata = parsed as Record<string, string>;
      pos += 2 + mlen;
    }
    forks.push({ type, prefix, ref, ...(metadata ? { metadata } : {}), record: data.slice(start, pos) });
  }
  if (pos !== data.length) throw new Error("mantaray: trailing bytes");
  return { entry, forks };
}

/** Encode a fork the way bee does. Metadata keys are written sorted, as Go's JSON does. */
export function encodeMantarayFork(f: { type: number; prefix: string; ref: string; metadata?: Record<string, string> }): Uint8Array {
  const prefix = new TextEncoder().encode(f.prefix);
  if (prefix.length < 1 || prefix.length > PREFIX_MAX) throw new Error(`mantaray: prefix "${f.prefix}" needs splitting`);
  const ref = hexToBytes(f.ref);
  if (ref.length !== REF_BYTES) throw new Error("mantaray: bad fork ref");
  const hasMeta = f.metadata !== undefined;
  if (hasMeta !== Boolean(f.type & MANTARAY_TYPE_METADATA)) throw new Error("mantaray: metadata flag mismatch");
  let meta = new Uint8Array(0);
  if (f.metadata) {
    const sorted = Object.fromEntries(Object.keys(f.metadata).sort().map((k) => [k, f.metadata![k]]));
    const json = new TextEncoder().encode(JSON.stringify(sorted));
    const n = 2 + json.length;
    const pad = n < 32 ? 32 - n : n === 32 ? 0 : 32 - (n % 32);
    const body = json.length + pad;
    if (body > 0xffff) throw new Error("mantaray: metadata too large");
    meta = new Uint8Array(2 + body).fill(0x0a);
    meta[0] = body >> 8;
    meta[1] = body & 0xff;
    meta.set(json, 2);
  }
  const out = new Uint8Array(FORK_FIXED + meta.length);
  out[0] = f.type;
  out[1] = prefix.length;
  out.set(prefix, 2);
  out.set(ref, 2 + PREFIX_MAX);
  out.set(meta, FORK_FIXED);
  return out;
}

/**
 * Encode a node as bee does: a 32-byte entry always present (zero when the node
 * has none), forks filed by their prefix's first byte. Each fork is an encoded
 * record (`encodeMantarayFork`, or one copied whole from another node).
 */
export function encodeMantarayNode(entry: string | null, forks: Uint8Array[]): Uint8Array {
  const bitmap = new Uint8Array(32);
  const byFirst = new Map<number, Uint8Array>();
  for (const rec of forks) {
    const first = rec[2]!;
    if (byFirst.has(first)) throw new Error(`mantaray: two forks start with byte ${first}`);
    byFirst.set(first, rec);
    bitmap[first >> 3] = bitmap[first >> 3]! | (1 << (first & 7));
  }
  const ordered = [...byFirst.keys()].sort((a, b) => a - b).map((k) => byFirst.get(k)!);
  const size = 64 + REF_BYTES + 32 + ordered.reduce((n, r) => n + r.length, 0);
  const out = new Uint8Array(size);
  out.set(VERSION_02_HASH, 32);
  out[63] = REF_BYTES;
  if (entry) {
    const e = hexToBytes(entry);
    if (e.length !== REF_BYTES) throw new Error("mantaray: bad entry");
    out.set(e, 64);
  }
  out.set(bitmap, 64 + REF_BYTES);
  let pos = 64 + REF_BYTES + 32;
  for (const r of ordered) {
    out.set(r, pos);
    pos += r.length;
  }
  return out;
}

/** A node's address: the `/bytes` root of its encoding. */
export function mantarayNodeAddress(node: Uint8Array): string {
  return bytesTreeRoot(node);
}

/**
 * The entry (data reference) `path` resolves to under `rootNode`, the way bee
 * walks a manifest. Every node read is checked against the address its parent
 * names, so the answer is bound to the root whatever `readNode` returns.
 */
export async function resolveMantarayPath(
  rootNode: Uint8Array,
  path: string,
  readNode: (address: string) => Promise<Uint8Array>,
): Promise<string> {
  let node = rootNode;
  let rest = path;
  for (let depth = 0; depth < 64; depth++) {
    const fork = parseMantarayNode(node).forks.find((f) => rest.startsWith(f.prefix));
    if (!fork) throw new Error(`mantaray: no ${path}`);
    const child = await readNode(fork.ref);
    if (mantarayNodeAddress(child) !== fork.ref) throw new Error("mantaray: a node does not match its address");
    rest = rest.slice(fork.prefix.length);
    if (rest === "") {
      const entry = parseMantarayNode(child).entry;
      if (!entry) throw new Error(`mantaray: ${path} has no data`);
      return entry;
    }
    node = child;
  }
  throw new Error("mantaray: path too deep");
}
