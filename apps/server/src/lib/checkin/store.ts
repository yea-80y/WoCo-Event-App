/**
 * Door check-in state — file-backed, same pattern as tx-registry.
 *
 * Three stores, all under .data/ (MUST survive restarts):
 *   door-passes.json         { [eventId]: { jti, exp } } — active pass per event
 *   checkin-rosters/{h}.json EncryptedRoster ciphertext (server never sees plaintext)
 *   checkins/{h}.json        CheckinRecord[] — the merged nullifier set
 *
 * A ticket is admitted ONCE across every scanner (#641) - check-in is a
 * capacity control. `claimCheckin` is the admission: a synchronous
 * read-check-write with no `await` inside, which on this single-process server
 * is atomic, and which persists BEFORE it answers, so a restart can never forget
 * an admission it confirmed. `mergeCheckins` (sync) still folds in what a
 * single-scanner pass admitted offline. Two devices holding the same ticket is
 * now a DEFECT to investigate, still reported as a conflict rather than hidden.
 *
 * The set is held in memory and written through: every reader and writer here
 * goes through `loadCheckins`/`commitCheckins`, so claim and sync cannot race.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../marketing/persist.js";
import {
  DOOR_PASS_VERSION,
  doorPassSigningInput,
  encodeDoorPassToken,
  decodeDoorPassToken,
  type DoorPassPayload,
  type CheckinRecord,
  type CheckinConflict,
  type DoorMode,
  type EncryptedRoster,
} from "@woco/shared";

const DATA_DIR = join(process.cwd(), ".data");
const PASSES_FILE = join(DATA_DIR, "door-passes.json");
const ROSTERS_DIR = join(DATA_DIR, "checkin-rosters");
const CHECKINS_DIR = join(DATA_DIR, "checkins");

/** eventIds aren't filesystem-safe — key files by their sha256. */
function eventFile(dir: string, eventId: string): string {
  return join(dir, `${createHash("sha256").update(eventId).digest("hex")}.json`);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

/**
 * Throws, unlike most stores: a pass the door can't verify, a roster the scanner
 * can't fetch and a check-in that isn't recorded are all failures the caller must
 * report rather than confirm. `tag` names the store on /api/health.
 */
function writeJson(file: string, tag: string, value: unknown): void {
  if (!writeJsonAtomic(file, value, tag)) {
    throw new Error(`check-in store ${tag} could not be persisted`);
  }
}

// ---------------------------------------------------------------------------
// Door passes
// ---------------------------------------------------------------------------

function passSecret(): string {
  const secret = process.env.CHECKIN_PASS_SECRET;
  if (!secret) throw new Error("CHECKIN_PASS_SECRET not configured");
  return secret;
}

function passTag(payload: DoorPassPayload): string {
  return createHmac("sha256", passSecret()).update(doorPassSigningInput(payload)).digest("hex");
}

/**
 * `signer` is the event's content-feed signer, resolved SERVER-side when the pass
 * was issued (the organiser was authenticated then). It is deliberately NOT a token
 * field: the token format is shared with the deployed scanner PWA and adding a field
 * would need a DOOR_PASS_VERSION bump that invalidates every live pass. Keeping it
 * here means /pack can resolve an unlisted client-signed event — which is otherwise
 * absent from the global directory and unreadable — with no client input and no
 * format change. Absent on passes issued before this existed: callers fall back.
 */
type PassRegistry = Record<string, {
  jti: string;
  exp: number;
  signer?: string;
  /** Absent on passes issued before #641: read as "several". */
  mode?: DoorMode;
  /** "single" passes: the one device allowed to use this pass, set by its first pack. */
  device?: string;
}>;

function readPasses(): PassRegistry {
  return readJson<PassRegistry>(PASSES_FILE) ?? {};
}

/**
 * Issue (or rotate) the door pass for an event. Rotation replaces the stored
 * jti, which immediately invalidates every previously issued token.
 */
export function issueDoorPass(eventId: string, exp: number, signer?: string, mode: DoorMode = "several"): string {
  const payload: DoorPassPayload = {
    v: DOOR_PASS_VERSION,
    eventId,
    jti: randomBytes(16).toString("hex"),
    exp,
  };
  const passes = readPasses();
  // A new jti starts with no bound device: regenerating is how an organiser
  // moves a single-scanner pass to another phone.
  passes[eventId] = { jti: payload.jti, exp, mode, ...(signer ? { signer } : {}) };
  writeJson(PASSES_FILE, "checkin-passes", passes);
  return encodeDoorPassToken(payload, passTag(payload));
}

export type PassVerdict =
  | { ok: true; eventId: string; signer?: string; mode: DoorMode; device?: string }
  | { ok: false; reason: "malformed" | "bad-sig" | "expired" | "revoked" };

/** Verify a door-pass token: HMAC tag, expiry, and active-jti (revocation). */
export function verifyDoorPass(token: string): PassVerdict {
  const decoded = decodeDoorPassToken(token);
  if (!decoded) return { ok: false, reason: "malformed" };
  const { payload, tagHex } = decoded;

  const expected = Buffer.from(passTag(payload), "hex");
  const actual = Buffer.from(tagHex, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: "bad-sig" };
  }
  if (payload.exp * 1000 < Date.now()) return { ok: false, reason: "expired" };

  const active = readPasses()[payload.eventId];
  if (!active || active.jti !== payload.jti) return { ok: false, reason: "revoked" };

  // The signer comes from OUR record for the active pass, not from the token.
  return {
    ok: true,
    eventId: payload.eventId,
    mode: active.mode ?? "several",
    ...(active.signer ? { signer: active.signer } : {}),
    ...(active.device ? { device: active.device } : {}),
  };
}

/**
 * Bind a "single" pass to the device loading it, or confirm it is already bound
 * to that device. False = the pass belongs to another device. Only the device
 * that holds the pass may admit offline, so a second device must be refused
 * before it can hold a pack at all.
 */
export function bindSinglePassDevice(eventId: string, deviceId: string): boolean {
  const passes = readPasses();
  const active = passes[eventId];
  if (!active) return false;
  if (active.device) return active.device === deviceId;
  passes[eventId] = { ...active, device: deviceId };
  writeJson(PASSES_FILE, "checkin-passes", passes);
  return true;
}

// ---------------------------------------------------------------------------
// Roster ciphertext
// ---------------------------------------------------------------------------

export function storeRoster(eventId: string, roster: EncryptedRoster): void {
  writeJson(eventFile(ROSTERS_DIR, eventId), "checkin-rosters", roster);
}

export function readRoster(eventId: string): EncryptedRoster | null {
  return readJson<EncryptedRoster>(eventFile(ROSTERS_DIR, eventId));
}

// ---------------------------------------------------------------------------
// Check-in set
// ---------------------------------------------------------------------------

function ticketKey(r: { seriesId: string; edition: number }): string {
  return `${r.seriesId}\0${r.edition}`;
}

const checkinCache = new Map<string, CheckinRecord[]>();

/**
 * The event's set, from memory or disk. A file that exists but cannot be read
 * THROWS: treating it as empty would let the next claim admit every ticket
 * again and then overwrite the record of who is already in.
 */
function loadCheckins(eventId: string): CheckinRecord[] {
  const cached = checkinCache.get(eventId);
  if (cached) return cached;
  const file = eventFile(CHECKINS_DIR, eventId);
  if (!existsSync(file)) return [];
  const parsed = readJson<CheckinRecord[]>(file);
  if (!Array.isArray(parsed)) throw new Error(`check-in set for ${eventId} is present but unreadable`);
  checkinCache.set(eventId, parsed);
  return parsed;
}

/** Write first, then publish to memory - a failed write changes nothing. */
function commitCheckins(eventId: string, records: CheckinRecord[]): void {
  writeJson(eventFile(CHECKINS_DIR, eventId), "checkins", records);
  checkinCache.set(eventId, records);
}

export function readCheckins(eventId: string): CheckinRecord[] {
  return loadCheckins(eventId);
}

function isValidRecord(r: unknown): r is CheckinRecord {
  if (!r || typeof r !== "object") return false;
  const rec = r as Record<string, unknown>;
  return (
    typeof rec.seriesId === "string" && rec.seriesId.length > 0 && rec.seriesId.length <= 128 &&
    typeof rec.edition === "number" && Number.isInteger(rec.edition) && rec.edition >= 1 &&
    typeof rec.at === "string" && rec.at.length <= 40 &&
    typeof rec.deviceId === "string" && rec.deviceId.length > 0 && rec.deviceId.length <= 64 &&
    (rec.method === "scan" || rec.method === "manual") &&
    (rec.claimId === undefined || (typeof rec.claimId === "string" && rec.claimId.length > 0 && rec.claimId.length <= 64))
  );
}

export type ClaimResult =
  | { status: "admitted"; record: CheckinRecord }
  | { status: "already-in"; record: CheckinRecord };

/**
 * Admit a ticket, or report who already holds it. FIRST CLAIM ANYWHERE WINS.
 *
 * Synchronous from the read to the write on purpose: with no `await` between
 * them, two claims for one ticket cannot interleave on this single-process
 * server, so exactly one is admitted. The record is persisted before this
 * returns (`commitCheckins` throws on failure, and the caller answers 503):
 * an admission a restart could forget is one the door must not act on.
 *
 * A claim carrying the claimId of the record that holds the ticket is that same
 * attempt retrying, and is told "admitted" again - never refused as a duplicate
 * of itself.
 */
export function claimCheckin(eventId: string, record: CheckinRecord): ClaimResult {
  if (!isValidRecord(record) || !record.claimId) throw new Error("invalid check-in claim");
  const existing = loadCheckins(eventId);
  const holder = existing.find((r) => ticketKey(r) === ticketKey(record));
  if (holder) {
    return holder.claimId === record.claimId
      ? { status: "admitted", record: holder }
      : { status: "already-in", record: holder };
  }
  commitCheckins(eventId, [...existing, record]);
  return { status: "admitted", record };
}

/**
 * Merge incoming device records into the event's set (union; earliest record
 * per (ticket, device) wins). Returns the full merged set plus tickets that
 * ended up with records from more than one device.
 */
export function mergeCheckins(
  eventId: string,
  incoming: CheckinRecord[],
): { checkins: CheckinRecord[]; conflicts: CheckinConflict[] } {
  const existing = loadCheckins(eventId);
  const byTicketAndDevice = new Map<string, CheckinRecord>();
  for (const r of [...existing, ...incoming.filter(isValidRecord)]) {
    const key = `${ticketKey(r)}\0${r.deviceId}`;
    const prev = byTicketAndDevice.get(key);
    if (!prev || r.at < prev.at) byTicketAndDevice.set(key, r);
  }

  const merged = [...byTicketAndDevice.values()].sort((a, b) => a.at.localeCompare(b.at));
  commitCheckins(eventId, merged);

  const byTicket = new Map<string, CheckinRecord[]>();
  for (const r of merged) {
    const key = ticketKey(r);
    byTicket.set(key, [...(byTicket.get(key) ?? []), r]);
  }
  const conflicts: CheckinConflict[] = [];
  for (const records of byTicket.values()) {
    if (records.length > 1) {
      conflicts.push({ seriesId: records[0].seriesId, edition: records[0].edition, records });
    }
  }
  return { checkins: merged, conflicts };
}
