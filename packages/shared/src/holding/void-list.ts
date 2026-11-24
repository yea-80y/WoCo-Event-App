/**
 * The signed VOID LIST: which receipts belong to refunded or charged-back sales.
 * Spec: woco-ops/spec-receipt-note-20261123.md section 6.
 *
 * It names receipts, never ticket numbers: an entry is a tag of a receipt's digest, so
 * only someone who holds the receipt, or was shown it, can look it up. Knowing a ticket
 * number tells nothing. Entries are padded with random values to the smallest of
 * 8, 16, 32, ... that fits, so one read shows a size band, not the refund count (someone
 * FOLLOWING the list over time can still estimate it: spec section 6).
 *
 * Each list is a full snapshot with a per-event `seq`. A verifier keeps the highest seq
 * it has seen and refuses a lower one; the same seq with another `entriesHash` means
 * the signer equivocated. Freshness is `validUntil`, re-signed on request.
 *
 * FROZEN: the domain, the type string, the tag label and the entries encoding.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { eip712DigestHex, type EIP712TypeField } from "../auth/eip712-digest.js";
import { recoverTypedStatementSigner, signTypedStatement, type TypedStatement } from "../crypto/digest-signature.js";
import type { Hex0x } from "../types.js";
import type { HoldingTarget } from "./receipt.js";

export const VOID_LIST_DOMAIN_NAME = "WoCo Void List";
export const VOID_LIST_DOMAIN_VERSION = "1";
export const VOID_TAG_LABEL = "woco/holding/v1/void-tag";

/** The smallest padded size. Sizes double from here. */
export const VOID_LIST_MIN_SIZE = 8;

/** A list that never expires: published once an event's chargeback horizon has passed. */
export const VOID_LIST_CLOSED = Number.MAX_SAFE_INTEGER;

export const VOID_LIST_FIELDS: readonly EIP712TypeField[] = [
  { name: "eventId", type: "bytes32" },
  { name: "entriesHash", type: "bytes32" },
  { name: "seq", type: "uint64" },
  { name: "issuedAt", type: "uint64" },
  { name: "validUntil", type: "uint64" },
];

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const BYTES32_RE = /^0x[0-9a-f]{64}$/;

/** keccak256(abi.encode(keccak256("woco/holding/v1/void-tag"), bytes32 receiptDigest)). */
export function voidTag(receiptDigest: string): Hex0x {
  if (!BYTES32_RE.test(receiptDigest)) throw new Error("receipt digest must be lowercase bytes32");
  const tag = keccak_256(utf8ToBytes(VOID_TAG_LABEL));
  return `0x${bytesToHex(keccak_256(concatBytes(tag, hexToBytes(receiptDigest.slice(2)))))}`;
}

/** The padded size for `realCount` entries: the smallest of 8, 16, 32, ... that fits. */
export function voidListSize(realCount: number): number {
  if (!Number.isSafeInteger(realCount) || realCount < 0) throw new Error("bad entry count");
  let size = VOID_LIST_MIN_SIZE;
  while (size < realCount) size *= 2;
  return size;
}

/**
 * Whether `entries` is a well-formed list: lowercase bytes32, strictly ascending (so
 * no duplicates), and exactly a padded size. A verifier refuses anything else.
 */
export function isValidVoidEntries(entries: readonly string[]): boolean {
  if (!Array.isArray(entries)) return false;
  if (entries.length < VOID_LIST_MIN_SIZE || entries.length !== voidListSize(entries.length)) return false;
  for (let i = 0; i < entries.length; i++) {
    if (typeof entries[i] !== "string" || !BYTES32_RE.test(entries[i]!)) return false;
    if (i > 0 && !(entries[i - 1]! < entries[i]!)) return false;
  }
  return true;
}

/**
 * Real tags plus random dummies, sorted. Draw the dummies ONCE per seq and keep them
 * with it: re-signing the same seq must give the same `entriesHash`.
 */
export function padVoidEntries(realTags: readonly string[], random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string[] {
  const set = new Set<string>();
  for (const t of realTags) {
    if (!BYTES32_RE.test(t)) throw new Error("void tag must be lowercase bytes32");
    set.add(t);
  }
  const size = voidListSize(set.size);
  while (set.size < size) set.add(`0x${bytesToHex(random(32))}`);
  return [...set].sort();
}

/** keccak256(abi.encodePacked(bytes32[] entries)). Entries must already be valid. */
export function voidEntriesHash(entries: readonly string[]): Hex0x {
  if (!isValidVoidEntries(entries)) throw new Error("void entries must be sorted, unique and a padded size");
  return `0x${bytesToHex(keccak_256(concatBytes(...entries.map((e) => hexToBytes(e.slice(2))))))}`;
}

export interface VoidListHeader {
  eventId: string;
  entriesHash: string;
  seq: number;
  issuedAt: number;
  validUntil: number;
}

function checkHeader(h: VoidListHeader): VoidListHeader {
  if (!BYTES32_RE.test(h.eventId) || !BYTES32_RE.test(h.entriesHash)) throw new Error("void list: eventId and entriesHash must be lowercase bytes32");
  for (const n of [h.seq, h.issuedAt, h.validUntil]) {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("void list: bad number");
  }
  return h;
}

export function voidListStatement(target: HoldingTarget, h: VoidListHeader): TypedStatement {
  checkHeader(h);
  if (!Number.isSafeInteger(target.chainId) || target.chainId <= 0 || !ADDRESS_RE.test(target.ledger)) {
    throw new Error("void list: bad target");
  }
  return {
    domain: { name: VOID_LIST_DOMAIN_NAME, version: VOID_LIST_DOMAIN_VERSION, chainId: target.chainId, verifyingContract: target.ledger },
    primaryType: "VoidList",
    fields: VOID_LIST_FIELDS,
    message: { eventId: h.eventId, entriesHash: h.entriesHash, seq: h.seq, issuedAt: h.issuedAt, validUntil: h.validUntil },
  };
}

export function voidListDigest(target: HoldingTarget, h: VoidListHeader): Hex0x {
  const s = voidListStatement(target, h);
  return eip712DigestHex(s.domain, s.primaryType, s.fields, s.message) as Hex0x;
}

export function signVoidList(target: HoldingTarget, h: VoidListHeader, signerPrivateKey: Uint8Array): string {
  return signTypedStatement(voidListStatement(target, h), signerPrivateKey);
}

export function recoverVoidListSigner(target: HoldingTarget, h: VoidListHeader, signature: unknown): string | null {
  try {
    return recoverTypedStatementSigner(voidListStatement(target, h), signature);
  } catch {
    return null;
  }
}

export type VoidListVerdict =
  | { kind: "fresh"; voided: boolean }
  | { kind: "unverified"; reason: "bad-signer" | "malformed" | "wrong-event" | "stale" | "rolled-back" | "equivocated" };

/**
 * Read one receipt against a list. `seen` is the highest list this verifier has kept
 * for the event (or null); the caller stores the returned header when the verdict is
 * fresh. A list it cannot trust is `unverified`, never "not void".
 */
export function checkVoidList(args: {
  target: HoldingTarget;
  eventId: string;
  header: VoidListHeader;
  entries: readonly string[];
  signature: unknown;
  expectedSigner: string;
  receiptDigest: string;
  nowSecs: number;
  seen: { seq: number; entriesHash: string } | null;
}): VoidListVerdict {
  const { header: h } = args;
  let tag: string;
  try {
    if (h.eventId !== args.eventId) return { kind: "unverified", reason: "wrong-event" };
    if (!isValidVoidEntries(args.entries) || voidEntriesHash(args.entries) !== h.entriesHash) return { kind: "unverified", reason: "malformed" };
    if (recoverVoidListSigner(args.target, h, args.signature) !== args.expectedSigner.toLowerCase()) return { kind: "unverified", reason: "bad-signer" };
    tag = voidTag(args.receiptDigest);
  } catch {
    return { kind: "unverified", reason: "malformed" };
  }
  // A broken clock or a broken stored seq (NaN) would pass every comparison below.
  if (!Number.isFinite(args.nowSecs) || (args.seen && !Number.isSafeInteger(args.seen.seq))) {
    return { kind: "unverified", reason: "malformed" };
  }
  if (args.seen) {
    if (h.seq < args.seen.seq) return { kind: "unverified", reason: "rolled-back" };
    if (h.seq === args.seen.seq && h.entriesHash !== args.seen.entriesHash) return { kind: "unverified", reason: "equivocated" };
  }
  if (args.nowSecs > h.validUntil) return { kind: "unverified", reason: "stale" };
  return { kind: "fresh", voided: args.entries.includes(tag) };
}
