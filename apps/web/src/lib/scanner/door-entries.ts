/**
 * Door entries on the scanner: later sales' email and card name, read from
 * `GET /api/checkin/:eventId/entries?since=N` and opened with the door entries key the
 * pass secret P gives (`doorEntriesKeypair`). Pure logic - no storage, no fetch - so the
 * rules are tested here and the store only wires them in.
 *
 *   - A page for another pass, or one that says `reset`, starts again from empty.
 *   - "add" opens its box; one that does not open, or names another ticket, is skipped
 *     and counted - one bad line never stops the rest.
 *   - "remove" is final: the ticket's entry goes and a tombstone stays, which also hides
 *     the ticket from the organiser's roster (an erased order), and a later "add" for it
 *     is ignored.
 *   - The door's list: tombstone > the organiser's roster (it carries order answers) > a
 *     sale's entry.
 *
 * The lattice code loads on first use, never on scanner boot. Display data only: no
 * door decision (admit, already in, couldn't confirm) reads any of it.
 */

import {
  SCANNER_DEVICE_HEADER,
  SCANNER_OUTDATED_REASON,
  type DoorEntriesPage,
  type DoorEntryLogItem,
  type DoorEntryPlaintext,
  type RosterEntry,
} from "@woco/shared";
import { doorKeyRefOf } from "@woco/shared/checkin/door-keys";
import { isExpiredRefusal } from "./pass-gate.js";

export const doorTicketKey = (t: { seriesId: string; edition: number }) => `${t.seriesId} ${t.edition}`;

export interface DoorEntriesState {
  /** The pass the entries were sealed under; null before the first page. */
  jti: string | null;
  /** Cursor for the next request. */
  next: number;
  /** Opened entries by ticket. */
  entries: Map<string, RosterEntry>;
  /** Tickets an erasure removed. */
  tombstones: Set<string>;
}

export function emptyDoorEntries(): DoorEntriesState {
  return { jti: null, next: 0, entries: new Map(), tombstones: new Set() };
}

export interface DoorEntriesContext {
  eventId: string;
  passSecret: Uint8Array;
  seriesName: (seriesId: string) => string;
}

/** Opens one line; injectable for tests. Rejects when the box does not open. */
export type OpenDoorEntry = (line: Extract<DoorEntryLogItem, { kind: "add" }>, jti: string, ctx: DoorEntriesContext) => Promise<DoorEntryPlaintext>;

const defaultOpen: OpenDoorEntry = async (line, jti, ctx) => {
  const [{ openBoxJson, doorEntrySealContext }, { doorEntriesKeypair }] = await Promise.all([
    import("@woco/shared/crypto/sealed-box"),
    import("@woco/shared/checkin/door-entries-key"),
  ]);
  const { secretKey } = doorEntriesKeypair(ctx.passSecret);
  try {
    return await openBoxJson<DoorEntryPlaintext>(secretKey, line.box, doorEntrySealContext(ctx.eventId, jti, line.seriesId, line.edition));
  } finally {
    secretKey.fill(0);
  }
};

function asRosterEntry(p: DoorEntryPlaintext, line: { seriesId: string; edition: number }, ctx: DoorEntriesContext): RosterEntry | null {
  if (!p || p.v !== 1 || p.seriesId !== line.seriesId || p.edition !== line.edition) return null;
  return {
    seriesId: line.seriesId,
    seriesName: ctx.seriesName(line.seriesId),
    edition: line.edition,
    ...(typeof p.buyerName === "string" && p.buyerName ? { name: p.buyerName } : {}),
    ...(typeof p.email === "string" && p.email ? { email: p.email } : {}),
    source: "sale",
  };
}

/** Apply one page; returns a new state and how many lines could not be opened. */
export async function applyDoorEntriesPage(
  state: DoorEntriesState,
  page: DoorEntriesPage,
  ctx: DoorEntriesContext,
  open: OpenDoorEntry = defaultOpen,
): Promise<{ state: DoorEntriesState; failed: number }> {
  const fresh = page.reset || state.jti !== page.jti;
  const entries = fresh ? new Map<string, RosterEntry>() : new Map(state.entries);
  const tombstones = fresh ? new Set<string>() : new Set(state.tombstones);
  let failed = 0;
  for (const line of [...page.log].sort((a, b) => a.seq - b.seq)) {
    const key = doorTicketKey(line);
    if (line.kind === "remove") {
      entries.delete(key);
      tombstones.add(key);
      continue;
    }
    if (tombstones.has(key)) continue;
    try {
      const entry = asRosterEntry(await open(line, page.jti, ctx), line, ctx);
      if (entry) entries.set(key, entry);
      else failed++;
    } catch {
      failed++;
    }
  }
  return { state: { jti: page.jti, next: page.next, entries, tombstones }, failed };
}

/** The door's list: tombstones hide a ticket, the organiser's roster wins, a sale fills the gaps. */
export function mergeDoorRoster(roster: RosterEntry[], state: DoorEntriesState): RosterEntry[] {
  const out = roster.filter((r) => !state.tombstones.has(doorTicketKey(r)));
  const have = new Set(out.map(doorTicketKey));
  for (const [key, entry] of state.entries) if (!have.has(key)) out.push(entry);
  return out;
}

/**
 * Whether the key the server says it seals to is the one this link derives. Not a
 * safeguard - a key that is not ours is never on this phone - but it turns "nothing
 * opens" into a plain warning. Null: the server has no key for this pass.
 */
export async function doorKeyMatches(passSecret: Uint8Array, doorKeyRef: string | null): Promise<boolean | null> {
  if (!doorKeyRef) return null;
  const { doorEntriesKeypair } = await import("@woco/shared/checkin/door-entries-key");
  const kp = doorEntriesKeypair(passSecret);
  kp.secretKey.fill(0);
  return doorKeyRefOf(kp.publicKey) === doorKeyRef;
}

// ── storage and transport ───────────────────────────────────────────────────

/** The stored form: plain arrays, so nothing depends on how a browser clones a Map. */
export interface StoredDoorEntries {
  jti: string | null;
  next: number;
  entries: RosterEntry[];
  tombstones: string[];
}

export function toStoredDoorEntries(s: DoorEntriesState): StoredDoorEntries {
  return { jti: s.jti, next: s.next, entries: [...s.entries.values()], tombstones: [...s.tombstones] };
}

const isStoredEntry = (e: unknown): e is RosterEntry => {
  const r = e as Partial<RosterEntry> | null;
  return !!r && typeof r === "object" && typeof r.seriesId === "string" && Number.isInteger(r.edition);
};

/**
 * What a reload starts from. Entries opened under another pass (a newer one replaced
 * it) or a value that does not read are dropped: the next poll fetches from the start.
 */
export function restoreDoorEntries(stored: unknown, passJti: string | null): DoorEntriesState {
  const s = stored as Partial<StoredDoorEntries> | null | undefined;
  if (
    !s || !passJti || s.jti !== passJti || !Number.isSafeInteger(s.next) || (s.next as number) < 0 ||
    !Array.isArray(s.entries) || !Array.isArray(s.tombstones)
  ) {
    return emptyDoorEntries();
  }
  const tombstones = new Set(s.tombstones.filter((t): t is string => typeof t === "string"));
  const entries = new Map<string, RosterEntry>();
  for (const e of s.entries) if (isStoredEntry(e) && !tombstones.has(doorTicketKey(e))) entries.set(doorTicketKey(e), e);
  return { jti: s.jti, next: s.next as number, entries, tombstones };
}

export type DoorEntriesAnswer =
  | { kind: "page"; page: DoorEntriesPage }
  /** Revoked, expired, for another event or bound to another phone: the pass is over. */
  | { kind: "dead"; message: string; expired: boolean }
  /** The server needs newer scanner code. */
  | { kind: "outdated" }
  /** Not now (no signal, 503, an answer that does not read): keep what is held. */
  | { kind: "later" };

export interface DoorEntriesCall {
  fetchFn: typeof fetch;
  apiBase: string;
  eventId: string;
  token: string;
  deviceId: string;
  since: number;
}

export async function fetchDoorEntriesPage(call: DoorEntriesCall): Promise<DoorEntriesAnswer> {
  let resp: Response;
  try {
    resp = await call.fetchFn(`${call.apiBase}/api/checkin/${encodeURIComponent(call.eventId)}/entries?since=${call.since}`, {
      headers: { "X-Door-Pass": call.token, [SCANNER_DEVICE_HEADER]: call.deviceId },
    });
  } catch {
    return { kind: "later" };
  }
  const body = (await resp.json().catch(() => null)) as { ok?: boolean; data?: DoorEntriesPage; error?: string; reason?: string } | null;
  if (resp.status === 400 && body?.reason === SCANNER_OUTDATED_REASON) return { kind: "outdated" };
  if (resp.status === 401 || resp.status === 403 || resp.status === 409) {
    return { kind: "dead", message: body?.error || "Door pass no longer valid", expired: isExpiredRefusal(resp.status, body) };
  }
  const page = body?.data;
  if (!resp.ok || !body?.ok || !page || typeof page.jti !== "string" || !Number.isSafeInteger(page.next) || !Array.isArray(page.log)) {
    return { kind: "later" };
  }
  return { kind: "page", page };
}
