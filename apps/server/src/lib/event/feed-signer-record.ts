/**
 * Each event's content-feed signer and verified creator, pinned at create (#670).
 *
 * Every Phase B event feed is a SOC the ORGANISER signs, so the money path can
 * read an event only if it knows which signer to read under, and it may never
 * take that from a request: a buyer could name a signer whose SOC says the price
 * is 0. Before this record the only trusted answer was the public directory, so
 * an UNLISTED event was sellable for the 10 minutes its create primed the cache,
 * then "Event not found" at every checkout.
 *
 * The signer comes from the authenticated create request and the creator from
 * the verified session parent (routes/events.ts). It is the same value the
 * directory already copies, recorded at its origin instead of read back out of
 * the organiser's own feed. Naming another account's signer at create is inert:
 * that account never signs a feed for an eventId this server minted for someone
 * else, so the organiser's own event just reads as absent.
 *
 * WHO IS PAID is not the signer's to say: it is the feed's `creatorAddress`,
 * which the organiser signs. `acceptEventFeed` refuses a recorded event whose
 * feed names a different creator, so the chain's organiser and the Stripe
 * account paid can never be two different people.
 *
 * WRITE-ONCE, one writer (`createEventV2`). A repeat write for an eventId THROWS:
 * ids are server-minted, so a second record is a bug at the trust root and the
 * create must fail before the organiser signs anything. Deliberately not a field
 * on the listing overlay, whose `seed` is rewritten by `/list` (#674) and
 * rebuilt from snapshots that never held an unlisted event.
 *
 * MUST SURVIVE RESTARTS. The server cannot rebuild it (creators are not
 * enumerable); an operator can restore one organiser's records, best effort,
 * from their creator index `woco/event/creator/{address}`, which carries both
 * values for every event, unlisted included. Losing it fails CLOSED: unlisted
 * events stop selling, listed ones fall back to the directory. A file that
 * exists and cannot be read is never overwritten; every write is refused and
 * `/api/health` `eventFeedSigners` alarms until an operator restores it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventFeed, Hex0x } from "@woco/shared";
import { writeJsonAtomic } from "../marketing/persist.js";

const FILE = join(process.cwd(), ".data", "event-feed-signers.json");
const ADDRESS = /^0x[0-9a-f]{40}$/;

export interface FeedSignerRecord {
  /** The organiser's content-feed signer, lowercase. */
  signer: Hex0x;
  /** The verified session parent that created the event, lowercase. */
  creatorAddress: Hex0x;
  recordedAt: string;
}

/** Thrown when a write would change an existing record. */
export class FeedSignerRebindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedSignerRebindError";
  }
}

/** Thrown by every write while the file on disk could not be understood. */
export class FeedSignerStoreUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedSignerStoreUnreadableError";
  }
}

/** Thrown when a record could not be made durable. */
export class FeedSignerWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedSignerWriteError";
  }
}

/**
 * A create that failed at this store. The messages name a `.data` file and are
 * for the operator's log; the organiser gets a plain sentence instead.
 */
export function isFeedSignerStoreError(err: unknown): boolean {
  return (
    err instanceof FeedSignerRebindError ||
    err instanceof FeedSignerStoreUnreadableError ||
    err instanceof FeedSignerWriteError
  );
}

let records = new Map<string, FeedSignerRecord>();
/** Entries that did not parse: kept on disk untouched, never served. */
let unparsed = new Map<string, unknown>();
let fileUnreadable: string | null = null;
let loaded = false;

function parseRecord(v: unknown): FeedSignerRecord | null {
  const r = v as Partial<FeedSignerRecord> | null;
  if (!r || typeof r !== "object") return null;
  if (typeof r.signer !== "string" || !ADDRESS.test(r.signer)) return null;
  if (typeof r.creatorAddress !== "string" || !ADDRESS.test(r.creatorAddress)) return null;
  if (typeof r.recordedAt !== "string") return null;
  return { signer: r.signer, creatorAddress: r.creatorAddress, recordedAt: r.recordedAt };
}

function refuseFile(why: string): void {
  fileUnreadable = why;
  console.error(
    `[feed-signers] ALARM: event-feed-signers.json ${why} - nothing is served from it and it will NOT be ` +
      "written until it is repaired or restored and the server restarted. Unlisted events cannot sell " +
      "and no event can be created with a feed signer until then (/api/health eventFeedSigners)",
  );
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  let raw: string;
  try {
    raw = readFileSync(FILE, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return; // first boot
    return refuseFile(`exists but could not be read (${code ?? "unknown error"})`);
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return refuseFile("is not valid JSON");
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return refuseFile("is not a JSON object");
  for (const [id, v] of Object.entries(obj as Record<string, unknown>)) {
    const r = parseRecord(v);
    if (r) records.set(id, r);
    else unparsed.set(id, v);
  }
  if (unparsed.size > 0) {
    console.error(
      `[feed-signers] ${unparsed.size} record(s) in event-feed-signers.json are unreadable - kept on disk ` +
        "untouched, NOT served: those events cannot sell until an operator repairs them",
    );
  }
}

/**
 * Pin an event's signer and creator. Called once, from `createEventV2`, before
 * the create answers. Idempotent only for identical values.
 */
export function recordEventFeedSigner(eventId: string, signer: string, creatorAddress: string): void {
  ensureLoaded();
  if (fileUnreadable) {
    throw new FeedSignerStoreUnreadableError(`event-feed-signers.json ${fileUnreadable}`);
  }
  const s = signer.toLowerCase();
  const c = creatorAddress.toLowerCase();
  if (!ADDRESS.test(s) || !ADDRESS.test(c)) {
    throw new Error("recordEventFeedSigner: signer and creator must be 0x-prefixed 20-byte addresses");
  }
  const prev = records.get(eventId);
  if (prev || unparsed.has(eventId)) {
    if (prev && prev.signer === s && prev.creatorAddress === c) return;
    throw new FeedSignerRebindError(`event ${eventId} already has a recorded feed signer`);
  }
  const rec: FeedSignerRecord = { signer: s as Hex0x, creatorAddress: c as Hex0x, recordedAt: new Date().toISOString() };
  records.set(eventId, rec);
  const out: Record<string, unknown> = Object.fromEntries(records);
  for (const [id, v] of unparsed) out[id] = v;
  if (!writeJsonAtomic(FILE, out, "feed-signers")) {
    // Not durable means not a record: the next restart would forget it and the
    // event would stop selling. Fail the create while nothing is signed yet.
    records.delete(eventId);
    throw new FeedSignerWriteError(`event ${eventId}: the feed signer record could not be written`);
  }
}

/** Zero I/O after the first load. Null for events created without a signer, or before this record. */
export function getRecordedFeedSigner(eventId: string): FeedSignerRecord | null {
  ensureLoaded();
  return records.get(eventId) ?? null;
}

/**
 * The feed a recorded event may be served as: refused when its own
 * `creatorAddress` is not the creator recorded at create (see header). Events
 * with no record (legacy, or created without a signer) pass unchanged.
 */
export function acceptEventFeed(eventId: string, feed: EventFeed | null): EventFeed | null {
  if (!feed) return feed;
  const rec = getRecordedFeedSigner(eventId);
  if (!rec) return feed;
  if ((feed.creatorAddress ?? "").toLowerCase() === rec.creatorAddress) return feed;
  console.error(
    `[feed-signers] REJECTED event ${eventId}: its feed names creator ${JSON.stringify(feed.creatorAddress)}, ` +
      `recorded at create as ${rec.creatorAddress} - treating as not found`,
  );
  return null;
}

/** `/api/health` section. Counts only: this endpoint is public. */
export function feedSignerRecordHealth(): {
  ok: boolean;
  unreadable: boolean;
  unreadableRecords: number;
  count: number;
} {
  ensureLoaded();
  const unreadable = fileUnreadable !== null;
  return { ok: !unreadable && unparsed.size === 0, unreadable, unreadableRecords: unparsed.size, count: records.size };
}

/** Tests only: forget memory so the next call reloads from disk. */
export function __resetFeedSignerRecordForTest(): void {
  records = new Map();
  unparsed = new Map();
  fileUnreadable = null;
  loaded = false;
}
