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
 *   - a request was never paid: 48 h (or sooner, the oldest first, past 5,000 unpaid);
 *   - its box is erased on the attendee batch by a data-subject request or the retention
 *     sweep: `sweepHoldings`;
 *   - 12 months after the event's on-chain end, on its own clock (`sweepHoldingsDue`), so a
 *     record whose attendee batch died (never swept there) still goes.
 * The buyer's own erase (pickup signer, routes/holdings.ts) does not delete it: it drops
 * the box, the sealed secret, the account and the email hash, and keeps the PUBLIC values
 * until the event's on-chain end, so a replacement ticket can be re-signed over the same
 * commitments (spec 5.2, 8). That "erased" record then goes at the end.
 *
 * One key, one sale: a pickup id, a holder or answer key, a pickup signer or a count-once
 * commitment that another record already names is refused (no receipt). An order secret is
 * random, so a repeat is a broken or hostile client.
 *
 * MUST SURVIVE RESTARTS until then. Losing a record loses that buyer's way to find
 * their receipt (the box on Swarm stays, at an address only the record and a guest's
 * email link name). A file present but unreadable is never overwritten, and
 * `/api/health` `holdingReceipts` is red until an operator restores it.
 */

import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { addCalendarMonthsUtc, CHECKOUT_SESSION_RE } from "@woco/shared";
import { isSealedBoxV2, type SealedBoxV2 } from "@woco/shared/crypto/sealed-box-shape";
import { HOLDING_RETENTION_MONTHS, type HoldingRequestV1 } from "@woco/shared/holding/request";
import { writeJsonAtomic } from "../marketing/persist.js";
import { errorClass } from "../http/error-class.js";

const DIR = join(process.cwd(), ".data", "holding-receipts");
const TAG = "holding-receipts";

/**
 * An unpaid request is dropped after this. Longer than a Stripe session's 24 h life, so
 * a webhook that arrives late (our server down a while) still finds the buyer's request.
 */
export const HOLDING_REQUEST_TTL_MS = 48 * 60 * 60 * 1000;
/** Unpaid requests kept at most; the oldest makes room (held orders' rule). */
export let MAX_UNPAID_REQUESTS = 5_000;

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
  /**
   * The buyer erased our copy: box, sealed secret, account and email hash are gone; the
   * public values stay until the event's on-chain end.
   */
  erasedAt?: string;
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const ROOT_RE = HEX64_RE;

const cache = new Map<string, HoldingRecordV1>();
const unreadable = new Set<string>();
/** Every value that must belong to one sale only -> that sale. Prefixed by kind so a pickup id never meets a commitment. */
const owners = new Map<string, string>();
const byBoxRoot = new Map<string, string>();
const health = {
  issued: 0,
  failed: 0,
  stored: 0,
  /** Paid sales owed receipts that got none, since boot (spec 5.3). */
  missed: 0,
  lastMissed: null as { at: string; why: string } | null,
  lastError: null as string | null,
};
const due = { lastRunAt: null as string | null, removed: 0, endUnknown: 0, lastError: null as string | null };
let dueRunning = false;
let scanned = false;

const fileOf = (sessionId: string) => join(DIR, `${sessionId}.json`);

function isRecord(x: unknown, sessionId: string): x is HoldingRecordV1 {
  const r = x as Partial<HoldingRecordV1> | null;
  if (!r || r.v !== 1 || r.sessionId !== sessionId) return false;
  if (typeof r.eventId !== "string" || typeof r.seriesId !== "string" || typeof r.createdAt !== "string") return false;
  if (r.keep !== "account" && r.keep !== "email") return false;
  if (r.erasedAt !== undefined) {
    // Erased: only public values left, and only for a sale that was paid.
    if (typeof r.erasedAt !== "string" || !r.issued || r.sealedR !== undefined || r.account !== undefined) return false;
    if (r.issued.box !== undefined || r.issued.emailHash !== undefined) return false;
  } else if (r.keep === "account" && (typeof r.account !== "string" || !ADDRESS_RE.test(r.account) || !isSealedBoxV2(r.sealedR))) {
    return false;
  }
  if (!Array.isArray(r.holders) || !Array.isArray(r.answerKeys) || r.holders.length !== r.answerKeys.length) return false;
  if (![...r.holders, ...r.answerKeys].every((a) => typeof a === "string")) return false;
  if (typeof r.pickupId !== "string" || !HEX64_RE.test(r.pickupId) || typeof r.pickupSigner !== "string") return false;
  if (typeof r.nkCommit !== "string") return false;
  if (r.issued) {
    const i = r.issued;
    if (!Number.isSafeInteger(i.chainId) || typeof i.ledger !== "string" || typeof i.onChainEventId !== "string") return false;
    if (!Array.isArray(i.slots) || typeof i.boxRoot !== "string" || !ROOT_RE.test(i.boxRoot)) return false;
    if (typeof i.issuedAt !== "string") return false;
    if (i.box !== undefined && !isSealedBoxV2(i.box)) return false;
  }
  return true;
}

/** The values one sale owns alone, as index keys. */
function ownedKeys(v: { pickupId: string; holders: string[]; answerKeys: string[]; pickupSigner: string; nkCommit: string }): string[] {
  return [
    `pickup:${v.pickupId}`,
    // Holders, answer keys and the pickup signer share one namespace: a key is one role in one sale.
    ...[...v.holders, ...v.answerKeys, v.pickupSigner].map((a) => `key:${a.toLowerCase()}`),
    `nk:${v.nkCommit.toLowerCase()}`,
  ];
}

/**
 * True when any of these values already belongs to a sale. Asked only before a sale's
 * first record is written, so a value it owns itself never reaches here.
 */
function claimedElsewhere(v: Parameters<typeof ownedKeys>[0]): boolean {
  return ownedKeys(v).some((k) => owners.has(k));
}

function remember(r: HoldingRecordV1): void {
  cache.set(r.sessionId, r);
  // First writer keeps a value. Only a hand-edited file can collide (every write path
  // refuses one); then deleting the later file never frees the earlier one's values.
  for (const k of ownedKeys(r)) if (!owners.has(k)) owners.set(k, r.sessionId);
  if (r.issued && !byBoxRoot.has(r.issued.boxRoot)) byBoxRoot.set(r.issued.boxRoot, r.sessionId);
}

function forget(sessionId: string): void {
  const r = cache.get(sessionId);
  if (r) {
    for (const k of ownedKeys(r)) if (owners.get(k) === sessionId) owners.delete(k);
    if (r.issued && byBoxRoot.get(r.issued.boxRoot) === sessionId) byBoxRoot.delete(r.issued.boxRoot);
  }
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
  let names: string[];
  try {
    names = readdirSync(DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      scanned = true;
      return;
    }
    throw err;
  }
  scanned = true;
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
  if (typeof pickupId !== "string" || !HEX64_RE.test(pickupId)) return null;
  scanOnce();
  const sessionId = owners.get(`pickup:${pickupId}`);
  return sessionId ? cache.get(sessionId) ?? null : null;
}

/** The record whose sealed box has this /bytes root, any state. */
export function holdingByBoxRoot(root: string): HoldingRecordV1 | null {
  const k = typeof root === "string" ? root.toLowerCase().replace(/^0x/, "") : "";
  if (!ROOT_RE.test(k)) return null;
  scanOnce();
  const sessionId = byBoxRoot.get(k);
  return sessionId ? cache.get(sessionId) ?? null : null;
}

export function holdingsForAccount(account: string): HoldingRecordV1[] {
  scanOnce();
  const a = account.toLowerCase();
  return [...cache.values()].filter((r) => r.keep === "account" && r.account === a);
}

/** Paid records naming this buyer's email hash: what an access or erasure request must also reach. */
export function holdingsForEmailHash(emailHash: string): HoldingRecordV1[] {
  scanOnce();
  return [...cache.values()].filter((r) => r.issued?.emailHash === emailHash);
}

/** Box roots being stored on the attendee batch right now (`keep.ts` sets them). */
const storingRoots = new Set<string>();

export function setHoldingBoxStoring(root: string, on: boolean): void {
  const k = root.toLowerCase().replace(/^0x/, "");
  if (on) storingRoots.add(k);
  else storingRoots.delete(k);
}

/**
 * A receipt box being stored right now. An erasure must wait for it (then burn it)
 * rather than tombstone a root whose chunks are landing.
 */
export function isHoldingBoxStoring(root: string): boolean {
  return storingRoots.has(root.toLowerCase().replace(/^0x/, ""));
}

/** Files present but unreadable: an answer drawn from the store may be missing them. */
export function holdingStoreUnreadable(): number {
  scanOnce();
  return unreadable.size;
}

function write(r: HoldingRecordV1): boolean {
  if (unreadable.has(r.sessionId)) return false;
  if (!writeJsonAtomic(fileOf(r.sessionId), r, TAG)) return false;
  remember(r);
  return true;
}

/**
 * A signed-in buyer's request, at create-checkout. Write-once: an existing record for
 * the session wins, and a request naming any value another sale owns is refused (an
 * order secret is random, so a repeat is a broken or hostile client). Never throws.
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
    if (claimedElsewhere(input.request)) return false;
    const unpaid = [...cache.values()].filter((r) => !r.issued);
    if (unpaid.length >= MAX_UNPAID_REQUESTS) {
      unpaid.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const old of unpaid.slice(0, unpaid.length - MAX_UNPAID_REQUESTS + 1)) deleteHolding(old.sessionId);
    }
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
    // A replay is "recorded" only if it names the same box; otherwise its link would
    // point at a box this record does not hold.
    if (existing?.issued) return existing.issued.boxRoot === input.issued.boxRoot;
    let base: HoldingRecordV1;
    if (existing) {
      if (input.guest && input.guest.pickupId !== existing.pickupId) return false;
      base = existing;
    } else if (input.guest) {
      if (claimedElsewhere(input.guest)) return false;
      base = { v: 1, sessionId: input.sessionId, eventId: input.eventId, seriesId: input.seriesId, createdAt: now, keep: "email", ...input.guest };
    } else {
      return false;
    }
    const boxOwner = byBoxRoot.get(input.issued.boxRoot);
    if (boxOwner !== undefined && boxOwner !== input.sessionId) return false;
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
    if (!r?.issued || r.issued.storedAt || r.erasedAt) return !!r?.issued;
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

/**
 * The local copy of a box an erasure reached before it was stored (`eraseOrder`, which
 * has already tombstoned its root so nothing can store it). The rest of the record is
 * the caller's to delete or mark erased. True when there is no box left here.
 */
export function dropHoldingBox(sessionId: string): boolean {
  try {
    const r = getHolding(sessionId);
    if (!r?.issued?.box) return true;
    const { box: _box, ...rest } = r.issued;
    return write({ ...r, issued: rest });
  } catch (err) {
    health.lastError = `box not dropped (${errorClass(err)})`;
    return false;
  }
}

/**
 * The buyer erased our copy (routes/holdings.ts), after the attendee-batch copy was
 * erased. Drops the box, the sealed secret, the account and the email hash; keeps the
 * public values until the event's on-chain end (spec 5.2: a replacement re-signs over
 * the same commitments, section 8). Idempotent. Never throws; false = not persisted.
 */
export function markHoldingErased(sessionId: string, now = Date.now()): boolean {
  try {
    const r = getHolding(sessionId);
    if (!r?.issued) return false;
    if (r.erasedAt) return true;
    const { sealedR: _sealedR, account: _account, ...kept } = r;
    const { box: _box, emailHash: _emailHash, ...issued } = r.issued;
    return write({ ...kept, issued, erasedAt: new Date(now).toISOString() });
  } catch (err) {
    health.lastError = `erase not recorded (${errorClass(err)})`;
    return false;
  }
}

/** Records whose box still needs storing on the attendee batch (the retry worker's list). */
export function unstoredHoldings(): HoldingRecordV1[] {
  scanOnce();
  return [...cache.values()].filter((r) => r.issued?.box && !r.issued.storedAt && !r.erasedAt);
}

/**
 * Drop what is no longer owed: a request never paid after 48 h, and any record whose box
 * the attendee batch has erased (retention or a data-subject request). A record the
 * BUYER erased is not dropped here: its box is erased by construction, and its public
 * values stay until the event's end (`sweepHoldingsDue`). Returns how many went.
 * `isErased` is the attendee ledger's own answer, never inferred here.
 */
export function sweepHoldings(isErased: (root: string) => boolean, now = Date.now()): number {
  scanOnce();
  let removed = 0;
  for (const r of [...cache.values()]) {
    const stale = !r.issued && now - Date.parse(r.createdAt) > HOLDING_REQUEST_TTL_MS;
    // Stored or not: a box erased before its upload landed can never be stored (the
    // ledger refuses it), so its local copy goes too.
    const erased = !!r.issued && !r.erasedAt && isErased(r.issued.boxRoot);
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

export interface HoldingDueDeps {
  /**
   * The on-chain end (epoch ms) of the event a record's receipts were signed for, or null
   * when the chain has none. Throws when it cannot say now.
   */
  chainEnd(r: HoldingRecordV1 & { issued: HoldingIssued }): Promise<number | null>;
  /** The chain's clock, epoch ms: "now" is the earlier of it and ours. */
  chainNow(chainId: number): Promise<number>;
  now(): number;
}

/**
 * Each paid record's own clock (spec 13a item 4), independent of the attendee batch: a
 * record goes 12 months after its event's on-chain end, or at the end itself once the
 * buyer has erased it. Every doubt keeps the record (no end on chain, a chain that
 * cannot answer): deleting is irreversible, keeping one more day is not, and a fast
 * server clock cannot delete early. Never throws.
 */
export async function sweepHoldingsDue(deps: HoldingDueDeps): Promise<{ removed: number; endUnknown: number }> {
  let removed = 0;
  let endUnknown = 0;
  // One pass at a time: a slow RPC must not stack a pass an hour.
  if (dueRunning) return { removed, endUnknown };
  dueRunning = true;
  try {
    scanOnce();
    const serverNow = deps.now();
    const ends = new Map<string, Promise<number | null>>();
    const clocks = new Map<number, Promise<number>>();
    for (const r of [...cache.values()]) {
      const i = r.issued;
      if (!i) continue;
      const key = `${i.chainId}:${i.ledger.toLowerCase()}:${i.onChainEventId.toLowerCase()}`;
      let end = ends.get(key);
      if (!end) ends.set(key, (end = deps.chainEnd(r as HoldingRecordV1 & { issued: HoldingIssued })));
      let endMs: number | null;
      try {
        endMs = await end;
      } catch {
        endMs = null;
      }
      if (endMs === null || !Number.isFinite(endMs)) {
        endUnknown++;
        continue;
      }
      const dueMs = r.erasedAt ? endMs : addCalendarMonthsUtc(endMs, HOLDING_RETENTION_MONTHS);
      if (serverNow < dueMs) continue;
      let clock = clocks.get(i.chainId);
      if (!clock) clocks.set(i.chainId, (clock = deps.chainNow(i.chainId)));
      let now: number;
      try {
        now = Math.min(serverNow, await clock);
      } catch {
        endUnknown++;
        continue;
      }
      if (!(now >= dueMs)) continue;
      try {
        deleteHolding(r.sessionId);
        removed++;
      } catch (err) {
        due.lastError = `due delete failed (${errorClass(err)})`;
      }
    }
    due.lastRunAt = new Date(serverNow).toISOString();
    due.removed = removed;
    due.endUnknown = endUnknown;
  } catch (err) {
    due.lastError = `due sweep failed (${errorClass(err)})`;
  } finally {
    dueRunning = false;
  }
  return { removed, endUnknown };
}

/**
 * A paid sale owed receipts got none (a plan, signing or keeping fault): counted, and red
 * until the next restart. Never throws.
 */
export function noteHoldingMissed(sessionId: string, why: string, now = Date.now()): void {
  health.missed++;
  health.lastMissed = { at: new Date(now).toISOString(), why: why.slice(0, 200) };
  console.error(`[holding] ${sessionId}: a paid sale got no receipt (${health.lastMissed.why})`);
}

/**
 * `/api/health`: red while a record is unreadable, a box has waited over an hour to be
 * stored, or (since boot) a paid sale owed receipts got none.
 */
export function holdingReceiptsHealth(now = Date.now()) {
  scanOnce();
  const waiting = unstoredHoldings().filter((r) => now - Date.parse(r.issued!.issuedAt) > 60 * 60 * 1000).length;
  const erased = [...cache.values()].filter((r) => r.erasedAt).length;
  return {
    ok: unreadable.size === 0 && waiting === 0 && health.missed === 0,
    unreadable: unreadable.size,
    unstoredOverAnHour: waiting,
    records: cache.size,
    erased,
    ...health,
    due: { ...due },
  };
}

export function _setMaxUnpaidRequestsForTests(n: number): void {
  MAX_UNPAID_REQUESTS = n;
}

export function _resetHoldingStoreForTests(): void {
  cache.clear();
  unreadable.clear();
  owners.clear();
  byBoxRoot.clear();
  scanned = false;
  MAX_UNPAID_REQUESTS = 5_000;
  health.issued = 0;
  health.failed = 0;
  health.stored = 0;
  health.missed = 0;
  health.lastMissed = null;
  health.lastError = null;
  due.lastRunAt = null;
  due.removed = 0;
  due.endUnknown = 0;
  due.lastError = null;
  dueRunning = false;
}
