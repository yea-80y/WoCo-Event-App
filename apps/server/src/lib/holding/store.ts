/**
 * Ticket receipts held for collection (woco-ops/spec-receipt-note-20261123.md 5.3).
 *
 *   .data/holding-receipts/{sessionId}.json
 *
 * One file per sale. A signed-in buyer's browser sends its order's PUBLIC values at
 * checkout (the request); fulfilment adds what was signed and the sealed box. A
 * guest's record is written whole at fulfilment, from a secret the server made and
 * put only in the ticket email (option A). Nothing here opens the box: it is sealed to
 * a key only the order's secret derives, and that secret is never stored.
 *
 * The box itself goes on the erasable attendee batch (kind "holding"); this file keeps
 * a copy only until that store lands. The record goes when:
 *   - the buyer erases it (pickup signer, routes/holdings.ts);
 *   - its box is erased on the attendee batch (12 months after the event, or a
 *     data-subject request): `sweepHoldings`;
 *   - a request was never paid: 24 h, as held orders.
 *
 * MUST SURVIVE RESTARTS until then. Losing a record loses that buyer's way to find
 * their receipt (the box on Swarm stays, at an address only the record and a guest's
 * email link name). A file present but unreadable is never overwritten, and
 * `/api/health` `holdingReceipts` is red until an operator restores it.
 */

import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CHECKOUT_SESSION_RE } from "@woco/shared";
import { isSealedBoxV2, type SealedBoxV2 } from "@woco/shared/crypto/sealed-box-shape";
import type { HoldingRequestV1 } from "@woco/shared/holding/request";
import { writeJsonAtomic } from "../marketing/persist.js";
import { errorClass } from "../http/error-class.js";

const DIR = join(process.cwd(), ".data", "holding-receipts");
const TAG = "holding-receipts";

/** An unpaid request is dropped after this, as an unpaid held order. */
export const HOLDING_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

export interface HoldingIssued {
  chainId: number;
  ledger: string;
  onChainEventId: string;
  slots: number[];
  /** The sealed box's /bytes root: where it is on the attendee batch, known before upload. */
  boxRoot: string;
  /** The sealed box, kept only until it is stored on the attendee batch. */
  box?: SealedBoxV2;
  storedAt?: string;
  issuedAt: string;
  /** The buyer's email HMAC, carried to the attendee-batch record so an access or erasure request finds the box. */
  emailHash?: string;
}

export interface HoldingRecordV1 {
  v: 1;
  sessionId: string;
  eventId: string;
  seriesId: string;
  createdAt: string;
  /** "account": the buyer's browser made the secret (sealedR); "email": the server made it for the ticket email. */
  keep: "account" | "email";
  /** The signed-in buyer's account (lowercase), for "account" records: what /mine answers by. */
  account?: string;
  holders: string[];
  answerKeys: string[];
  nkCommit: string;
  pickupId: string;
  pickupSigner: string;
  pickupPub: string;
  sealedR?: SealedBoxV2;
  issued?: HoldingIssued;
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const ROOT_RE = HEX64_RE;

const cache = new Map<string, HoldingRecordV1>();
const unreadable = new Set<string>();
const byPickup = new Map<string, string>();
const health = { issued: 0, failed: 0, stored: 0, lastError: null as string | null };
let scanned = false;

const fileOf = (sessionId: string) => join(DIR, `${sessionId}.json`);

function isRecord(x: unknown, sessionId: string): x is HoldingRecordV1 {
  const r = x as Partial<HoldingRecordV1> | null;
  if (!r || r.v !== 1 || r.sessionId !== sessionId) return false;
  if (typeof r.eventId !== "string" || typeof r.seriesId !== "string" || typeof r.createdAt !== "string") return false;
  if (r.keep !== "account" && r.keep !== "email") return false;
  if (r.keep === "account" && (typeof r.account !== "string" || !ADDRESS_RE.test(r.account) || !isSealedBoxV2(r.sealedR))) return false;
  if (!Array.isArray(r.holders) || !Array.isArray(r.answerKeys) || r.holders.length !== r.answerKeys.length) return false;
  if (typeof r.pickupId !== "string" || !HEX64_RE.test(r.pickupId) || typeof r.pickupSigner !== "string") return false;
  if (r.issued) {
    const i = r.issued;
    if (!Number.isSafeInteger(i.chainId) || typeof i.ledger !== "string" || typeof i.onChainEventId !== "string") return false;
    if (!Array.isArray(i.slots) || typeof i.boxRoot !== "string" || !ROOT_RE.test(i.boxRoot)) return false;
    if (i.box !== undefined && !isSealedBoxV2(i.box)) return false;
  }
  return true;
}

function remember(r: HoldingRecordV1): void {
  cache.set(r.sessionId, r);
  byPickup.set(r.pickupId, r.sessionId);
}

function forget(sessionId: string): void {
  const r = cache.get(sessionId);
  if (r && byPickup.get(r.pickupId) === sessionId) byPickup.delete(r.pickupId);
  cache.delete(sessionId);
  unreadable.delete(sessionId);
}

/** From disk. Throws for a file present but unreadable, which then stays (and alarms). */
function readRecord(sessionId: string): HoldingRecordV1 | null {
  let raw: string;
  try {
    raw = readFileSync(fileOf(sessionId), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      unreadable.delete(sessionId);
      return null;
    }
    unreadable.add(sessionId);
    throw new Error("holding record unreadable");
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!isRecord(parsed, sessionId)) {
    unreadable.add(sessionId);
    throw new Error("holding record unreadable");
  }
  unreadable.delete(sessionId);
  return parsed;
}

/** Load every record once, so pickup ids resolve after a restart. Unreadable files are counted, never touched. */
function scanOnce(): void {
  if (scanned) return;
  scanned = true;
  let names: string[];
  try {
    names = readdirSync(DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const sessionId = name.slice(0, -5);
    if (!CHECKOUT_SESSION_RE.test(sessionId)) continue;
    try {
      const r = readRecord(sessionId);
      if (r) remember(r);
    } catch {
      // counted in `unreadable`
    }
  }
}

/** The sale's record, or null. Throws when it is present but unreadable. */
export function getHolding(sessionId: string): HoldingRecordV1 | null {
  if (!CHECKOUT_SESSION_RE.test(sessionId)) return null;
  scanOnce();
  const cached = cache.get(sessionId);
  if (cached) return cached;
  if (unreadable.has(sessionId)) throw new Error("holding record unreadable");
  const r = readRecord(sessionId);
  if (r) remember(r);
  return r;
}

export function holdingByPickupId(pickupId: string): HoldingRecordV1 | null {
  if (!HEX64_RE.test(pickupId)) return null;
  scanOnce();
  const sessionId = byPickup.get(pickupId);
  return sessionId ? cache.get(sessionId) ?? null : null;
}

export function holdingsForAccount(account: string): HoldingRecordV1[] {
  scanOnce();
  const a = account.toLowerCase();
  return [...cache.values()].filter((r) => r.keep === "account" && r.account === a);
}

function write(r: HoldingRecordV1): boolean {
  if (unreadable.has(r.sessionId)) return false;
  if (!writeJsonAtomic(fileOf(r.sessionId), r, TAG)) return false;
  remember(r);
  return true;
}

/**
 * A signed-in buyer's request, at create-checkout. Write-once: an existing record for
 * the session wins, and a pickup id already used by another sale is refused (an order
 * secret is random, so a repeat is a broken or hostile client). Never throws.
 */
export function recordHoldingRequest(input: {
  sessionId: string;
  eventId: string;
  seriesId: string;
  account: string;
  request: HoldingRequestV1;
  now?: number;
}): boolean {
  try {
    if (!CHECKOUT_SESSION_RE.test(input.sessionId) || !ADDRESS_RE.test(input.account.toLowerCase())) return false;
    if (getHolding(input.sessionId)) return true;
    if (holdingByPickupId(input.request.pickupId)) return false;
    const q = input.request;
    return write({
      v: 1,
      sessionId: input.sessionId,
      eventId: input.eventId,
      seriesId: input.seriesId,
      createdAt: new Date(input.now ?? Date.now()).toISOString(),
      keep: "account",
      account: input.account.toLowerCase(),
      holders: q.holders,
      answerKeys: q.answerKeys,
      nkCommit: q.nkCommit,
      pickupId: q.pickupId,
      pickupSigner: q.pickupSigner,
      pickupPub: q.pickupPub,
      sealedR: q.sealedR,
    });
  } catch (err) {
    health.lastError = `request not recorded (${errorClass(err)})`;
    return false;
  }
}

/**
 * What fulfilment signed, with the sealed box. For an "account" record it completes the
 * request; for a guest it writes the whole record (`guest` carries the public values).
 * Write-once on `issued`. Never throws; false = nothing persisted.
 */
export function recordHoldingIssued(input: {
  sessionId: string;
  eventId: string;
  seriesId: string;
  guest?: Omit<HoldingRecordV1, "v" | "sessionId" | "eventId" | "seriesId" | "createdAt" | "keep" | "account" | "sealedR" | "issued">;
  issued: Omit<HoldingIssued, "issuedAt">;
  now?: number;
}): boolean {
  try {
    const now = new Date(input.now ?? Date.now()).toISOString();
    const existing = getHolding(input.sessionId);
    if (existing?.issued) return true;
    let base: HoldingRecordV1;
    if (existing) {
      base = existing;
    } else if (input.guest) {
      if (holdingByPickupId(input.guest.pickupId)) return false;
      base = { v: 1, sessionId: input.sessionId, eventId: input.eventId, seriesId: input.seriesId, createdAt: now, keep: "email", ...input.guest };
    } else {
      return false;
    }
    const ok = write({ ...base, issued: { ...input.issued, issuedAt: now } });
    if (ok) health.issued++;
    else health.failed++;
    return ok;
  } catch (err) {
    health.failed++;
    health.lastError = `receipts not recorded (${errorClass(err)})`;
    return false;
  }
}

/** The box landed on the attendee batch: drop the local copy. */
export function markHoldingStored(sessionId: string, now = Date.now()): boolean {
  try {
    const r = getHolding(sessionId);
    if (!r?.issued || r.issued.storedAt) return !!r?.issued;
    const { box: _box, ...rest } = r.issued;
    const ok = write({ ...r, issued: { ...rest, storedAt: new Date(now).toISOString() } });
    if (ok) health.stored++;
    return ok;
  } catch (err) {
    health.lastError = `stored mark failed (${errorClass(err)})`;
    return false;
  }
}

/** Remove one record and any half-written copy beside it. Already gone is not a failure. */
export function deleteHolding(sessionId: string): void {
  if (!CHECKOUT_SESSION_RE.test(sessionId)) return;
  for (const file of [fileOf(sessionId), `${fileOf(sessionId)}.tmp`]) {
    try {
      unlinkSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  forget(sessionId);
}

/** Records whose box still needs storing on the attendee batch (the retry worker's list). */
export function unstoredHoldings(): HoldingRecordV1[] {
  scanOnce();
  return [...cache.values()].filter((r) => r.issued?.box && !r.issued.storedAt);
}

/**
 * Drop what is no longer owed: a request never paid after 24 h, and any record whose box
 * the attendee batch has erased (retention or a data-subject request). Returns how many
 * went. `isErased` is the attendee ledger's own answer, never inferred here.
 */
export function sweepHoldings(isErased: (root: string) => boolean, now = Date.now()): number {
  scanOnce();
  let removed = 0;
  for (const r of [...cache.values()]) {
    const stale = !r.issued && now - Date.parse(r.createdAt) > HOLDING_REQUEST_TTL_MS;
    const erased = !!r.issued?.storedAt && isErased(r.issued.boxRoot);
    if (stale || erased) {
      try {
        deleteHolding(r.sessionId);
        removed++;
      } catch (err) {
        health.lastError = `sweep delete failed (${errorClass(err)})`;
      }
    }
  }
  return removed;
}

/** `/api/health`: red while a record is unreadable or a box has waited over an hour to be stored. */
export function holdingReceiptsHealth(now = Date.now()) {
  scanOnce();
  const waiting = unstoredHoldings().filter((r) => now - Date.parse(r.issued!.issuedAt) > 60 * 60 * 1000).length;
  return { ok: unreadable.size === 0 && waiting === 0, unreadable: unreadable.size, unstoredOverAnHour: waiting, records: cache.size, ...health };
}

export function _resetHoldingStoreForTests(): void {
  cache.clear();
  unreadable.clear();
  byPickup.clear();
  scanned = false;
  health.issued = 0;
  health.failed = 0;
  health.stored = 0;
  health.lastError = null;
}
