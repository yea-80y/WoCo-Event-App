/**
 * The ticket RECEIPT, how it is SHOWN, and the v3 mint FINGERPRINT.
 * Spec: woco-ops/spec-receipt-note-20261123.md sections 3, 4 and 8b.
 *
 * A receipt is signed by the slot's one-time key at the sale, while that key owns the
 * slot, and binds the slot to values derived from the buyer's secret (`derive.ts`). It
 * is a statement WoCo makes once, which anyone can check against the chain: dedup by
 * (chainId, ledger, eventId, slot), never by signature.
 *
 * A receipt is NEVER accepted alone. It is shown inside a presentation signed by its
 * answer key and naming the one account it is for, so a copy passed on is useless.
 *
 * FROZEN: the domain name and version, every type string, the leaf tag and the root
 * encoding. Change one and every receipt issued so far stops verifying.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { eip712DigestHex, type EIP712TypeField } from "../auth/eip712-digest.js";
import { recoverTypedStatementSigner, signTypedStatement, type TypedStatement } from "../crypto/digest-signature.js";
import type { Hex0x } from "../types.js";
import { HOLDING_MAX_TICKETS } from "./derive.js";

export const HOLDING_DOMAIN_NAME = "WoCo Ticket Holding";
export const HOLDING_DOMAIN_VERSION = "1";

/** The chain and ledger a slot was minted on: from the server's registration record, never an event feed. */
export interface HoldingTarget {
  chainId: number;
  ledger: string;
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const BYTES32_RE = /^0x[0-9a-f]{64}$/;

function checkTarget(t: HoldingTarget): HoldingTarget {
  if (!Number.isSafeInteger(t.chainId) || t.chainId <= 0) throw new Error("holding target: bad chainId");
  if (!ADDRESS_RE.test(t.ledger)) throw new Error("holding target: ledger must be a lowercase address");
  return t;
}

function domainOf(t: HoldingTarget) {
  checkTarget(t);
  return { name: HOLDING_DOMAIN_NAME, version: HOLDING_DOMAIN_VERSION, chainId: t.chainId, verifyingContract: t.ledger };
}

export const TICKET_HOLDING_FIELDS: readonly EIP712TypeField[] = [
  { name: "eventId", type: "bytes32" },
  { name: "slot", type: "uint256" },
  { name: "holder", type: "address" },
  { name: "answerKey", type: "address" },
  { name: "nkCommit", type: "bytes32" },
];

export interface TicketHolding {
  /** The ON-CHAIN event id, 0x + 64 lowercase hex. */
  eventId: string;
  /** 0-based slot (edition - 1). */
  slot: number;
  holder: string;
  answerKey: string;
  nkCommit: string;
}

function checkHolding(h: TicketHolding): TicketHolding {
  if (!BYTES32_RE.test(h.eventId)) throw new Error("receipt: eventId must be lowercase bytes32");
  if (!Number.isSafeInteger(h.slot) || h.slot < 0) throw new Error("receipt: bad slot");
  if (!ADDRESS_RE.test(h.holder) || !ADDRESS_RE.test(h.answerKey)) throw new Error("receipt: addresses must be lowercase");
  if (!BYTES32_RE.test(h.nkCommit)) throw new Error("receipt: nkCommit must be lowercase bytes32");
  return h;
}

export function ticketHoldingStatement(target: HoldingTarget, h: TicketHolding): TypedStatement {
  checkHolding(h);
  return {
    domain: domainOf(target),
    primaryType: "TicketHolding",
    fields: TICKET_HOLDING_FIELDS,
    message: { eventId: h.eventId, slot: h.slot, holder: h.holder, answerKey: h.answerKey, nkCommit: h.nkCommit },
  };
}

/** The receipt's EIP-712 digest: what presentations name and void tags hash. */
export function ticketHoldingDigest(target: HoldingTarget, h: TicketHolding): Hex0x {
  const s = ticketHoldingStatement(target, h);
  return eip712DigestHex(s.domain, s.primaryType, s.fields, s.message) as Hex0x;
}

/** Signed by the slot's one-time key, at the sale, before that key is discarded. */
export function signTicketHolding(target: HoldingTarget, h: TicketHolding, burnerPrivateKey: Uint8Array): string {
  return signTypedStatement(ticketHoldingStatement(target, h), burnerPrivateKey);
}

/** Lowercase signer, or null for anything that is not a canonical (low-s, v 27/28) signature. */
export function recoverTicketHoldingSigner(target: HoldingTarget, h: TicketHolding, signature: unknown): string | null {
  try {
    return recoverTypedStatementSigner(ticketHoldingStatement(target, h), signature);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export const HOLDING_PRESENTATION_FIELDS: readonly EIP712TypeField[] = [
  { name: "receipt", type: "bytes32" },
  { name: "audience", type: "address" },
  { name: "context", type: "bytes32" },
  { name: "issuedAt", type: "uint64" },
  { name: "expiresAt", type: "uint64" },
];

/** The longest a presentation may be valid for. */
export const HOLDING_PRESENTATION_MAX_SECS = 30 * 24 * 60 * 60;

export interface HoldingPresentation {
  /** `ticketHoldingDigest` of the receipt shown. */
  receipt: string;
  /** The account the presentation is for. */
  audience: string;
  /** The verifier's challenge or the purpose, 32 bytes. */
  context: string;
  issuedAt: number;
  expiresAt: number;
}

function checkPresentation(p: HoldingPresentation): HoldingPresentation {
  if (!BYTES32_RE.test(p.receipt) || !BYTES32_RE.test(p.context)) throw new Error("presentation: receipt and context must be lowercase bytes32");
  if (!ADDRESS_RE.test(p.audience)) throw new Error("presentation: audience must be a lowercase address");
  if (!Number.isSafeInteger(p.issuedAt) || !Number.isSafeInteger(p.expiresAt) || p.issuedAt < 0 || p.expiresAt < 0) {
    throw new Error("presentation: bad window");
  }
  return p;
}

export function holdingPresentationStatement(target: HoldingTarget, p: HoldingPresentation): TypedStatement {
  checkPresentation(p);
  return {
    domain: domainOf(target),
    primaryType: "HoldingPresentation",
    fields: HOLDING_PRESENTATION_FIELDS,
    message: { receipt: p.receipt, audience: p.audience, context: p.context, issuedAt: p.issuedAt, expiresAt: p.expiresAt },
  };
}

export function signHoldingPresentation(target: HoldingTarget, p: HoldingPresentation, answerPrivateKey: Uint8Array): string {
  if (p.expiresAt <= p.issuedAt || p.expiresAt - p.issuedAt > HOLDING_PRESENTATION_MAX_SECS) {
    throw new Error("presentation: window must be positive and at most 30 days");
  }
  return signTypedStatement(holdingPresentationStatement(target, p), answerPrivateKey);
}

export type PresentationRefusal = "malformed" | "not-this-receipt" | "wrong-audience" | "wrong-context" | "not-yet-valid" | "expired" | "window-too-long" | "wrong-signer";

/**
 * Whether `p` is a valid showing of receipt `h` TO the verifier, at `nowSecs`. It says
 * nothing about the receipt's own standing (signer, chain, refunds): that is the
 * receipt verifier's job, run on top of this.
 */
export function checkHoldingPresentation(args: {
  target: HoldingTarget;
  receipt: TicketHolding;
  presentation: HoldingPresentation;
  signature: unknown;
  expectedAudience: string;
  expectedContext: string;
  nowSecs: number;
}): { ok: true } | { ok: false; reason: PresentationRefusal } {
  const { target, receipt, presentation: p, signature } = args;
  let digest: string;
  try {
    checkPresentation(p);
    digest = ticketHoldingDigest(target, receipt);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (p.receipt !== digest) return { ok: false, reason: "not-this-receipt" };
  if (p.audience !== args.expectedAudience.toLowerCase()) return { ok: false, reason: "wrong-audience" };
  if (p.context !== args.expectedContext.toLowerCase()) return { ok: false, reason: "wrong-context" };
  if (p.expiresAt <= p.issuedAt || p.expiresAt - p.issuedAt > HOLDING_PRESENTATION_MAX_SECS) return { ok: false, reason: "window-too-long" };
  // A broken clock (NaN, undefined) would pass both comparisons below.
  if (!Number.isFinite(args.nowSecs)) return { ok: false, reason: "malformed" };
  if (args.nowSecs < p.issuedAt) return { ok: false, reason: "not-yet-valid" };
  if (args.nowSecs > p.expiresAt) return { ok: false, reason: "expired" };
  const signer = recoverTypedStatementSigner(holdingPresentationStatement(target, p), signature);
  if (signer === null || signer !== receipt.answerKey) return { ok: false, reason: "wrong-signer" };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// v3 mint fingerprint (spec 8b): leaves hold the buyer's values, never the slot
// ---------------------------------------------------------------------------

export const HOLDING_LEAF_TAG = "woco/holding/v1/leaf";

function bytes32(hex: string, what: string): Uint8Array {
  if (!BYTES32_RE.test(hex)) throw new Error(`${what} must be lowercase bytes32`);
  return hexToBytes(hex.slice(2));
}

function address32(addr: string): Uint8Array {
  if (!ADDRESS_RE.test(addr)) throw new Error("address must be lowercase");
  const out = new Uint8Array(32);
  out.set(hexToBytes(addr.slice(2)), 12);
  return out;
}

/** keccak256(abi.encode(bytes32 keccak256(tag), address holder, address answerKey, bytes32 nkCommit)). */
export function holdingLeaf(holder: string, answerKey: string, nkCommit: string): Hex0x {
  const tag = keccak_256(utf8ToBytes(HOLDING_LEAF_TAG));
  return `0x${bytesToHex(keccak_256(concatBytes(tag, address32(holder), address32(answerKey), bytes32(nkCommit, "nkCommit"))))}`;
}

/** keccak256(abi.encodePacked(bytes32[] leaves)), leaves in position (= slot) order. */
export function holdingRoot(leaves: readonly string[]): Hex0x {
  if (leaves.length < 1 || leaves.length > HOLDING_MAX_TICKETS) throw new Error(`a root covers 1..${HOLDING_MAX_TICKETS} leaves`);
  return `0x${bytesToHex(keccak_256(concatBytes(...leaves.map((l) => bytes32(l, "leaf")))))}`;
}
