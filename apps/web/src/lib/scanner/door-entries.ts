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
 * The lattice code loads on first use, never on scanner boot.
 */

import type { DoorEntriesPage, DoorEntryLogItem, DoorEntryPlaintext, RosterEntry } from "@woco/shared";
import { doorKeyRefOf } from "@woco/shared/checkin/door-keys";

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
