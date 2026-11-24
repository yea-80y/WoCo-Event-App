/**
 * The BUYER'S OWN copy of a receipt, kept in their account's private storage on Swarm.
 * Spec: woco-ops/spec-receipt-note-20261123.md section 5.1 ("Own copy", "Rotation").
 *
 * One copy per order: the order's secret `r` and its checked receipt box, sealed to the
 * account's CURRENT order key (`holdingCopySealContext`) and stored as a content feed
 * owned by the account's own copy signer (`holdingCopySigner`). Its topic is salted from
 * the CURRENT account secret, so nobody without that secret can look a copy up, open it,
 * or tie it to an order, and a passkey removed from the account cannot find copies made
 * after the removal. One index per account generation lists the orders, sealed the same
 * way (`holdingIndexSealContext`).
 *
 * What a save still shows: each one is a signed chunk sent through WoCo's relay under the
 * buyer's session, which pays for storage. So WoCo's server sees that the account stored
 * sealed data, how much and when; Etherna and any node holding a chunk see the copy
 * signer's address, sizes and times, but not whose account it is.
 *
 * VERSIONED, NOT FROZEN: a passkey removal or an upgrade to a passkey rewrites all of
 * it under new keys, so the layout can change with a reader that reads both.
 */

import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { deriveSecpFromSeed } from "../crypto/secp-hkdf.js";
import { parseHoldingBox, type HoldingBoxV1 } from "./box.js";
import { HOLDING_MAX_TICKETS, HOLDING_SECRET_BYTES } from "./derive.js";

export const HOLDING_TOPIC_SALT_INFO = "woco/holding/v1/topic-salt";
export const HOLDING_COPY_SIGNER_INFO = "woco/holding/v1/copy-signer";
export const HOLDING_TOPIC_PREFIX = "woco/holding/v1/";
const INDEX_LABEL = "woco/holding/v1/index";

/** The most orders one index lists: far past any buyer, short of an unbounded read. */
export const HOLDING_INDEX_MAX_ORDERS = 5000;

const PICKUP_ID_RE = /^[0-9a-f]{64}$/;
const SECRET_HEX_RE = /^[0-9a-f]{64}$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const BYTES32_RE = /^0x[0-9a-f]{64}$/;
const ID_RE = /^[0-9a-z-]{1,64}$/;

/** salt_g = HKDF-SHA256(S_g, "", "woco/holding/v1/topic-salt", 32). */
export function holdingTopicSalt(accountSecret: Uint8Array): Uint8Array {
  if (!(accountSecret instanceof Uint8Array) || accountSecret.length !== 32) throw new Error("account secret must be 32 bytes");
  return hkdf(sha256, accountSecret, new Uint8Array(0), utf8ToBytes(HOLDING_TOPIC_SALT_INFO), 32);
}

/**
 * The key that owns the account's copies and their list, from the same account secret
 * (owner decision 2026-11-24). Its OWN key, never the public content-feed signer: every
 * stored chunk names its owner, and the content-feed signer also owns the public
 * profile, so with it anyone holding a chunk could tie the save to that profile.
 */
export function holdingCopySigner(accountSecret: Uint8Array): { privateKey: Uint8Array; address: string } {
  if (!(accountSecret instanceof Uint8Array) || accountSecret.length !== 32) throw new Error("account secret must be 32 bytes");
  return deriveSecpFromSeed(bytesToHex(accountSecret), HOLDING_COPY_SIGNER_INFO, "account secret");
}

function topicOf(salt: Uint8Array, message: Uint8Array): string {
  if (!(salt instanceof Uint8Array) || salt.length !== 32) throw new Error("holding topic salt must be 32 bytes");
  return HOLDING_TOPIC_PREFIX + bytesToHex(hmac(sha256, salt, message));
}

/** Where one order's copy lives: the prefix and HMAC-SHA256(salt_g, pickupId bytes). */
export function holdingCopyTopic(salt: Uint8Array, pickupId: string): string {
  if (!PICKUP_ID_RE.test(pickupId)) throw new Error("pickup id must be 64 lowercase hex");
  return topicOf(salt, hexToBytes(pickupId));
}

/** Where the generation's index lives. Its message is not 32 bytes, so it can never equal an order's. */
export function holdingIndexTopic(salt: Uint8Array): string {
  return topicOf(salt, utf8ToBytes(INDEX_LABEL));
}

// ---------------------------------------------------------------------------
// The copy
// ---------------------------------------------------------------------------

export interface HoldingCopyV1 {
  v: 1;
  /** The order's secret, 64 lowercase hex: what every key of the receipt derives from. */
  r: string;
  /** The receipts, checked and sorted by slot (`checkHoldingBox`). */
  box: HoldingBoxV1;
}

export function holdingCopyOf(r: Uint8Array, box: HoldingBoxV1): HoldingCopyV1 {
  if (!(r instanceof Uint8Array) || r.length !== HOLDING_SECRET_BYTES) throw new Error("holding secret must be 32 bytes");
  return { v: 1, r: bytesToHex(r), box };
}

const ENVELOPE_KEYS = [
  "chainId", "ledger", "eventId", "slot", "holder", "answerKey", "nkCommit", "wocoEventId", "seriesId", "edition", "sig",
] as const;

/** The same secret and the same receipts in the same order, field by field (key order never counts). */
export function sameHoldingCopy(a: HoldingCopyV1, b: HoldingCopyV1): boolean {
  if (a.r !== b.r || a.box.receipts.length !== b.box.receipts.length) return false;
  return a.box.receipts.every((e, i) => ENVELOPE_KEYS.every((k) => e[k] === b.box.receipts[i]![k]));
}

export function parseHoldingCopy(x: unknown): HoldingCopyV1 | null {
  const c = x as Partial<HoldingCopyV1> | null;
  if (!c || typeof c !== "object" || c.v !== 1 || typeof c.r !== "string" || !SECRET_HEX_RE.test(c.r)) return null;
  const box = parseHoldingBox(c.box);
  return box ? { v: 1, r: c.r, box } : null;
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

/** One order, with enough to mark the buyer's tickets without opening every copy. */
export interface HoldingIndexEntry {
  pickupId: string;
  chainId: number;
  ledger: string;
  /** The ON-CHAIN event id. */
  eventId: string;
  /** WoCo's event and series ids, as the receipts carry them (hints). */
  wocoEventId: string;
  seriesId: string;
  /** The ticket numbers (slot + 1) the order's receipts cover, ascending. */
  editions: number[];
}

export interface HoldingIndexV1 {
  v: 1;
  orders: HoldingIndexEntry[];
}

export function holdingIndexEntryOf(pickupId: string, box: HoldingBoxV1): HoldingIndexEntry {
  const first = box.receipts[0];
  if (!first || !PICKUP_ID_RE.test(pickupId)) throw new Error("holding index entry: empty box or bad pickup id");
  return {
    pickupId,
    chainId: first.chainId,
    ledger: first.ledger,
    eventId: first.eventId,
    wocoEventId: first.wocoEventId,
    seriesId: first.seriesId,
    editions: box.receipts.map((e) => e.edition).sort((a, b) => a - b),
  };
}

function isEntry(x: unknown): x is HoldingIndexEntry {
  const e = x as Partial<HoldingIndexEntry> | null;
  return (
    !!e && typeof e === "object" &&
    typeof e.pickupId === "string" && PICKUP_ID_RE.test(e.pickupId) &&
    Number.isSafeInteger(e.chainId) && (e.chainId as number) > 0 &&
    typeof e.ledger === "string" && ADDRESS_RE.test(e.ledger) &&
    typeof e.eventId === "string" && BYTES32_RE.test(e.eventId) &&
    typeof e.wocoEventId === "string" && ID_RE.test(e.wocoEventId) &&
    typeof e.seriesId === "string" && ID_RE.test(e.seriesId) &&
    Array.isArray(e.editions) && e.editions.length >= 1 && e.editions.length <= HOLDING_MAX_TICKETS &&
    e.editions.every((n) => Number.isSafeInteger(n) && n >= 1)
  );
}

/** An index, or null. One entry per pickup id. */
export function parseHoldingIndex(x: unknown): HoldingIndexV1 | null {
  const i = x as Partial<HoldingIndexV1> | null;
  if (!i || typeof i !== "object" || i.v !== 1 || !Array.isArray(i.orders)) return null;
  if (i.orders.length > HOLDING_INDEX_MAX_ORDERS || !i.orders.every(isEntry)) return null;
  if (new Set(i.orders.map((e) => e.pickupId)).size !== i.orders.length) return null;
  return { v: 1, orders: i.orders.map((e) => ({ ...e, editions: [...e.editions] })) };
}

/** `index` with `entry` in it, replacing any entry for the same order. */
export function withHoldingIndexEntry(index: HoldingIndexV1 | null, entry: HoldingIndexEntry): HoldingIndexV1 {
  const rest = (index?.orders ?? []).filter((e) => e.pickupId !== entry.pickupId);
  if (rest.length >= HOLDING_INDEX_MAX_ORDERS) throw new Error("this account's receipt list is full");
  return { v: 1, orders: [...rest, entry] };
}

/** Same order, same tickets: what makes a rewrite of an index unnecessary. */
export function sameHoldingIndexEntry(a: HoldingIndexEntry, b: HoldingIndexEntry): boolean {
  return (
    a.pickupId === b.pickupId && a.chainId === b.chainId && a.ledger === b.ledger && a.eventId === b.eventId &&
    a.wocoEventId === b.wocoEventId && a.seriesId === b.seriesId &&
    a.editions.length === b.editions.length && a.editions.every((n, i) => n === b.editions[i])
  );
}
