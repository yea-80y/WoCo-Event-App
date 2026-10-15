/**
 * Door entries: the live door attendee list.
 *
 * Each sale's email and card name, sealed at fulfilment to the door entries key the
 * event's CURRENT door pass registered (`door-key.ts`), so door phones list a new buyer
 * within a minute and this server - which held both in plaintext to send the ticket
 * email anyway - can never read the stored copy back. Order-form answers are never
 * here: the buyer sealed those to the organiser, and they reach the door only through
 * the roster the organiser's dashboard pushes.
 *
 *   .data/checkin-door-entries/{sha256(eventId)}.json   { v: 1, jti, doorKey, last, log }
 *
 * One append-only log per event, for one pass. `last` is the highest seq ever given, so
 * a cursor never sees a number twice even after lines are deleted. A removal (an erased
 * order) deletes that ticket's sealed line and appends a final "remove", which reaches
 * every online scanner. Regenerating the pass replaces the file - everything in it was
 * sealed to a key no new pass can open - and the roster sweep deletes it 2 days after
 * the event's onchain end.
 *
 * Present but unreadable: never overwritten by a sale or a removal, `/entries` answers
 * 503, and `/api/health` `doorEntries` is red. Only regenerating replaces it.
 */

import { readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { hexToBytes } from "@noble/hashes/utils.js";
import { DOOR_PASS_ID_RE, doorKeyRefOf } from "@woco/shared/checkin/door-keys";
import type { DoorEntriesPage, DoorEntryLogItem, DoorEntryPlaintext } from "@woco/shared";
import { writeJsonAtomic } from "../marketing/persist.js";
import { errorClass } from "../http/error-class.js";
import { activeDoorPass, eventKey } from "./store.js";

const DIR = join(process.cwd(), ".data", "checkin-door-entries");
const TAG = "checkin-door-entries";
/** Lines per `/entries` answer: a first load of a big event comes in a few pages. */
export const DOOR_ENTRIES_PAGE = 500;

interface EntriesFile {
  v: 1;
  jti: string;
  /** The registered X-Wing public key, hex. */
  doorKey: string;
  /** The highest seq ever given in this file. */
  last: number;
  log: DoorEntryLogItem[];
}

export class DoorEntriesUnreadableError extends Error {
  constructor() {
    super("door entries are present but unreadable");
    this.name = "DoorEntriesUnreadableError";
  }
}

const cache = new Map<string, EntriesFile>();
const unreadable = new Set<string>();
const health = { sealed: 0, removed: 0, failed: 0, lastError: null as string | null };

const fileOf = (key: string) => join(DIR, `${key}.json`);
const ticket = (t: { seriesId: string; edition: number }) => `${t.seriesId}\0${t.edition}`;

function isEntriesFile(x: unknown): x is EntriesFile {
  const f = x as Partial<EntriesFile> | null;
  return (
    !!f && f.v === 1 && typeof f.jti === "string" && DOOR_PASS_ID_RE.test(f.jti) &&
    typeof f.doorKey === "string" && Number.isInteger(f.last) && Array.isArray(f.log)
  );
}

/** The event's file, or null when there is none. Throws when it is present but unreadable. */
function load(eventId: string): EntriesFile | null {
  const key = eventKey(eventId);
  const cached = cache.get(key);
  if (cached) return cached;
  let raw: string;
  try {
    raw = readFileSync(fileOf(key), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      unreadable.delete(key);
      return null;
    }
    unreadable.add(key);
    throw new DoorEntriesUnreadableError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!isEntriesFile(parsed)) {
    unreadable.add(key);
    throw new DoorEntriesUnreadableError();
  }
  unreadable.delete(key);
  cache.set(key, parsed);
  return parsed;
}

/** Write first, then publish to memory - a failed write changes nothing. */
function commit(eventId: string, f: EntriesFile): void {
  const key = eventKey(eventId);
  if (!writeJsonAtomic(fileOf(key), f, TAG)) throw new Error("door entries could not be persisted");
  unreadable.delete(key);
  cache.set(key, f);
}

/**
 * A new pass: an empty log for its id and key, replacing whatever the last pass had -
 * even an unreadable file, since nothing in it opens under the new key. Throws when it
 * cannot be written; the caller then issues no pass.
 */
export function startDoorEntries(eventId: string, jti: string, doorKey: string): void {
  commit(eventId, { v: 1, jti, doorKey, last: 0, log: [] });
}

const quietUnlink = (file: string) => {
  try {
    unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
};

/**
 * Start a new pass's log, then `issue` the pass. If the log cannot be started nothing
 * is issued; if issuing throws, the previous pass's log is put back exactly as it was
 * - its file (readable or not) or no file - so that pass's scanners and sales carry on.
 * Synchronous, so no seal or removal can touch the file in between. The previous file
 * waits beside it as `.prev` until the pass is issued.
 */
export function issueWithNewDoorEntries<T>(eventId: string, jti: string, doorKey: string, issue: () => T): T {
  const key = eventKey(eventId);
  const file = fileOf(key);
  const aside = `${file}.prev`;
  let moved = false;
  try {
    renameSync(file, aside);
    moved = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const cached = cache.get(key);
  const wasUnreadable = unreadable.has(key);
  try {
    startDoorEntries(eventId, jti, doorKey);
    const out = issue();
    if (moved) quietUnlink(aside);
    return out;
  } catch (err) {
    try {
      quietUnlink(file);
      if (moved) renameSync(aside, file);
      if (cached) cache.set(key, cached);
      else cache.delete(key);
      if (wasUnreadable) unreadable.add(key);
      else unreadable.delete(key);
    } catch (undoErr) {
      health.failed++;
      health.lastError = `previous log not restored (${errorClass(undoErr)})`;
      console.error("[checkin] the previous door entries log could not be put back:", errorClass(undoErr));
    }
    throw err;
  }
}

/**
 * Seal one sale's tickets for the door. Never throws - the door list is a convenience,
 * never the sale - and checks only local state: a current, unexpired pass with a
 * registered key that matches this file. Idempotent per ticket, and a removed ticket is
 * never added back.
 */
export async function sealDoorEntries(
  eventId: string,
  tickets: Array<{ seriesId: string; edition: number }>,
  who: { email?: string; buyerName?: string },
  now: number = Date.now(),
): Promise<number> {
  try {
    if (!who.email && !who.buyerName) return 0;
    const pass = activeDoorPass(eventId);
    if (!pass?.doorKeyRef || pass.exp * 1000 <= now) return 0;
    const f = load(eventId);
    if (!f || f.jti !== pass.jti || doorKeyRefOf(hexToBytes(f.doorKey)) !== pass.doorKeyRef) return 0;
    const known = new Set(f.log.map(ticket));
    const todo = [...new Map(tickets.filter((t) => !known.has(ticket(t))).map((t) => [ticket(t), t])).values()];
    if (todo.length === 0) return 0;

    const { sealBoxJson, doorEntrySealContext } = await import("@woco/shared/crypto/sealed-box");
    const sealed = [];
    for (const t of todo) {
      const plain: DoorEntryPlaintext = {
        v: 1,
        seriesId: t.seriesId,
        edition: t.edition,
        ...(who.email ? { email: who.email } : {}),
        ...(who.buyerName ? { buyerName: who.buyerName } : {}),
      };
      sealed.push({ t, box: await sealBoxJson(f.doorKey, plain, doorEntrySealContext(eventId, f.jti, t.seriesId, t.edition)) });
    }

    // Read again after the awaits, then check and append with no await in between, so
    // two sales for one event cannot drop each other's lines.
    const cur = load(eventId);
    if (!cur || cur.jti !== f.jti) return 0;
    const seen = new Set(cur.log.map(ticket));
    const at = new Date(now).toISOString();
    let last = cur.last;
    const lines: DoorEntryLogItem[] = sealed
      .filter((s) => !seen.has(ticket(s.t)))
      .map((s) => ({ seq: ++last, kind: "add", seriesId: s.t.seriesId, edition: s.t.edition, box: s.box, at }));
    if (lines.length === 0) return 0;
    commit(eventId, { ...cur, last, log: [...cur.log, ...lines] });
    health.sealed += lines.length;
    return lines.length;
  } catch (err) {
    health.failed++;
    health.lastError = `seal failed (${errorClass(err)})`;
    console.error("[checkin] door entries could not be sealed (the sale stands):", errorClass(err));
    return 0;
  }
}

/**
 * An erased order: delete its tickets' sealed lines and append a final removal each,
 * which tells every online scanner to drop the ticket - from the organiser's roster too.
 * Never throws (the erasure itself has happened); a failure is on `/api/health`.
 */
export function removeDoorEntries(
  eventId: string,
  tickets: Array<{ seriesId: string; edition: number }>,
  now: number = Date.now(),
): number {
  try {
    const f = load(eventId);
    if (!f) return 0;
    const removed = new Set(f.log.filter((i) => i.kind === "remove").map(ticket));
    const gone = new Set(tickets.map(ticket));
    const todo = [...new Map(tickets.filter((t) => !removed.has(ticket(t))).map((t) => [ticket(t), t])).values()];
    const keep = f.log.filter((i) => !(i.kind === "add" && gone.has(ticket(i))));
    if (todo.length === 0 && keep.length === f.log.length) return 0;
    const at = new Date(now).toISOString();
    let last = f.last;
    const lines: DoorEntryLogItem[] = todo.map((t) => ({ seq: ++last, kind: "remove", seriesId: t.seriesId, edition: t.edition, at }));
    commit(eventId, { ...f, last, log: [...keep, ...lines] });
    health.removed += lines.length;
    return lines.length;
  } catch (err) {
    health.failed++;
    health.lastError = `removal failed (${errorClass(err)})`;
    console.error("[checkin] door entries removal failed:", errorClass(err));
    return 0;
  }
}

/**
 * The log after `since`, for the pass asking. Another pass's file (regenerated since, or
 * not written) reads as empty. A cursor past the end means the file was replaced: start
 * again from empty. Throws `DoorEntriesUnreadableError`; the route answers 503.
 */
export function readDoorEntriesPage(eventId: string, passJti: string, since: number, limit = DOOR_ENTRIES_PAGE): DoorEntriesPage {
  const f = load(eventId);
  if (!f || f.jti !== passJti) return { jti: passJti, doorKeyRef: null, next: 0, reset: since > 0, more: false, log: [] };
  const reset = since > f.last;
  const from = reset ? 0 : since;
  const log = f.log.filter((i) => i.seq > from).slice(0, limit);
  const next = log.length > 0 ? log[log.length - 1]!.seq : from;
  return {
    jti: f.jti,
    doorKeyRef: doorKeyRefOf(hexToBytes(f.doorKey)),
    next,
    reset,
    more: f.log.some((i) => i.seq > next),
    log,
  };
}

/** The `eventKey` of every stored file. No directory yet = none. */
export function storedDoorEntryKeys(): string[] {
  let names: string[];
  try {
    names = readdirSync(DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names.filter((n) => /^[0-9a-f]{64}\.json$/.test(n)).map((n) => n.slice(0, 64));
}

/** Delete one event's file and any copy beside it (a crashed write's, or a crashed issue's). Already gone is not a failure. */
export function deleteDoorEntries(key: string): void {
  for (const file of [fileOf(key), `${fileOf(key)}.tmp`, `${fileOf(key)}.prev`]) quietUnlink(file);
  cache.delete(key);
  unreadable.delete(key);
}

/** Forget what memory holds, as a restart would: the next read goes to disk. */
export function _dropDoorEntriesCacheForTests(): void {
  cache.clear();
}

/** `/api/health`: red while a file is present but unreadable. Counts since boot. */
export function doorEntriesHealth() {
  return { ok: unreadable.size === 0, unreadable: unreadable.size, ...health };
}
