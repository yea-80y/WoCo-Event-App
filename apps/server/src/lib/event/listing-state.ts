/**
 * Global-directory listing state (#37) — the small server-side overlay the
 * chain-log directory design needs.
 *
 * WHY this exists: with the paged directory retired, "is this event listed in the
 * GLOBAL public directory?" no longer has a home — the chain `Registered` log
 * carries no unlist/tombstone event, and it's not organiser content (it's WoCo's
 * curation decision about WoCo's own directory). So it lives here, file-backed like
 * `onchain-events.json`, read through a single seam
 * (`isListedForSnapshot`) so a future portable/community-moderated home is a
 * non-breaking swap.
 *
 * TRUST / SOVEREIGNTY: this decides directory MEMBERSHIP, not event existence. The
 * organiser's event is fully theirs (content on Swarm + mint anchor on chain,
 * listable anywhere). WoCo controlling its own list is the correct separation —
 * and it's the moderation lever a public, payment-taking directory must have.
 *
 * DEFAULT-EXCLUDE: no row ⇒ NOT listed. A registered-but-unrecorded event (lost
 * overlay, legacy event) stays hidden rather than leaking skipAutoList / site-
 * builder-only events into the public directory. `createEventV2` seeds the row.
 */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SnapshotCard } from "@woco/shared";
import { writeJsonAtomic } from "../marketing/persist.js";

const DATA_DIR = join(process.cwd(), ".data");
const FILE = join(DATA_DIR, "event-listing-state.json");
const PENDING_FILE = join(DATA_DIR, "event-listing-state.pending.json");

export interface ListingRow {
  /** In the WoCo global directory. */
  listed: boolean;
  /**
   * Set by a deliberate organiser/ops `/list` action (NOT by create-time auto-seed).
   * This is what lets the builder surface an event with NO on-chain registration —
   * a federated event, or a re-listed legacy event. A created-but-never-registered
   * WoCo event (auto-listed at create, registration failed/abandoned) has this FALSE,
   * so it stays hidden until registration or a deliberate re-list. See directory-snapshot.
   */
  explicitlyListed?: boolean;
  /** Deleted (tombstoned). Terminal — a tombstoned event never re-lists. */
  tombstoned?: boolean;
  updatedAt: string;
  /**
   * Card seed captured at create / list. The snapshot builder prefers a fresh
   * `getEvent` resolution (picks up edits + onChainEventId), but falls back to this
   * seed when the event can't be resolved locally — the ONLY source for federated
   * (self-hosted) organisers, and a safety net against a transient content read.
   */
  seed?: SnapshotCard;
}

const rows = new Map<string, ListingRow>();
/** Changes made on purpose while FILE could not take them (broken, or not there and not yet restored): what PENDING_FILE holds. */
const pending = new Map<string, ListingRow>();
let loaded = false;
/** Why the file on disk could not be understood, or null. While set, nothing is written to it. */
let unreadable: string | null = null;
/** PENDING_FILE is there and cannot be understood: it is not applied and not written either. */
let pendingUnreadable = false;
/** FILE did not load (not there, or not understood), so memory may lack rows it held. */
let incomplete = false;

function isRow(v: unknown): v is ListingRow {
  return !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as ListingRow).listed === "boolean";
}

/** A file's rows, "missing", or why it cannot be used. One wrong row refuses the
 *  whole file: a row that is not a row is a file something else wrote into. */
function readRows(file: string): Map<string, ListingRow> | "missing" | { why: string } {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" ? "missing" : { why: `exists but could not be read (${code ?? "unknown error"})` };
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { why: "is not valid JSON" };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { why: "is not a JSON object" };
  const out = new Map<string, ListingRow>();
  for (const [k, v] of Object.entries(obj)) {
    if (!isRow(v)) return { why: "holds an entry that is not a listing row" };
    out.set(k, v);
  }
  return out;
}

/**
 * A file that is there and cannot be understood is not an empty overlay. Read
 * as one, the first listing change (or the builder's reseed) wrote a new file
 * over it, and with it went every unlisted and deleted event's row, which no
 * snapshot holds. So FILE is left exactly as it is for repair, and the server
 * carries on from memory.
 *
 * Memory is then INCOMPLETE, as it is when the file is simply not there: rows
 * that were listed may be missing, and default-exclude would drop those events
 * from the next directory. The builder asks (`needsRestoreFromSnapshot`) and
 * gives every card of the last snapshot a row where there is none
 * (`restoreFromSnapshot`). It used to ask "are there no rows at all?", which one
 * change made before the first rebuild answered "no" to, and the rebuild then
 * published a directory of that one event.
 *
 * FILE is only ever written from memory that is whole. Written before the
 * restore, it would hold a few rows and load at the next start as the whole
 * listing: a restart before the first rebuild, and that rebuild published a
 * directory of those rows alone. So until the restore, what people change goes
 * to PENDING_FILE, whether FILE is broken or simply not there, and a FILE that
 * was not there is written by the restore, once memory is whole.
 *
 * What people change while FILE is unreadable must outlive the repair, or a
 * cancelled, taken down or deleted event comes back with the repaired file's
 * older rows. Those changes stay in PENDING_FILE. It is read at every start, so
 * they survive a restart while FILE is still broken, and once FILE loads again
 * they are applied on top of it and PENDING_FILE is removed. Restored rows are
 * not changes and are not kept there: the repaired file knows better.
 */
function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;

  const main = readRows(FILE);
  incomplete = !(main instanceof Map);
  if (main instanceof Map) {
    for (const [k, v] of main) rows.set(k, v);
    console.log(`[listing-state] Loaded ${rows.size} event listing rows`);
  } else if (main !== "missing") {
    unreadable = main.why;
    console.error(
      `[listing-state] ALARM: event-listing-state.json ${main.why} - left as it is for repair. Listing changes go ` +
        "to event-listing-state.pending.json until it is repaired and the server restarted (/api/health listingState)",
    );
  }

  const kept = readRows(PENDING_FILE);
  if (kept === "missing") return;
  if (!(kept instanceof Map)) {
    pendingUnreadable = true;
    console.error(
      `[listing-state] ALARM: event-listing-state.pending.json ${kept.why} - the changes it holds are NOT applied ` +
        "and it is left as it is (/api/health listingState)",
    );
    return;
  }
  for (const [k, v] of kept) {
    rows.set(k, v);
    pending.set(k, v);
  }
  // Only over a FILE that loaded: on their own these rows are not the whole listing.
  if (incomplete) return;
  if (!writeJsonAtomic(FILE, Object.fromEntries(rows), "listing-state")) return;
  rmSync(PENDING_FILE, { force: true });
  pending.clear();
  console.warn(`[listing-state] applied ${kept.size} change(s) made while event-listing-state.json could not be used`);
}

/** Save a change someone made to `eventId`'s row: in FILE once it can hold the whole listing, beside it until then. */
function persist(eventId: string): void {
  if (!unreadable && !incomplete) {
    if (!writeJsonAtomic(FILE, Object.fromEntries(rows), "listing-state")) return;
    // Left behind when the rewrite at start-up failed. FILE holds its rows now;
    // applied again at the next start, it would undo changes made since.
    if (pending.size > 0) {
      rmSync(PENDING_FILE, { force: true });
      pending.clear();
    }
    return;
  }
  if (pendingUnreadable) return;
  pending.set(eventId, rows.get(eventId)!);
  writeJsonAtomic(PENDING_FILE, Object.fromEntries(pending), "listing-state-pending");
}

/**
 * Whether memory may lack rows the file held: it did not load. Until the builder
 * has restored from the last snapshot, "no row" does not mean "not listed".
 */
export function needsRestoreFromSnapshot(): boolean {
  ensureLoaded();
  return incomplete;
}

/**
 * Give each card of the last snapshot a row where there is none (each card WAS
 * a listed event), and count memory as complete again. Never over a row that is
 * there: that is a file row, or an unlist, cancel or delete made since, and the
 * snapshot is older than all of them. Restored rows never go to PENDING_FILE.
 */
export function restoreFromSnapshot(cards: SnapshotCard[]): number {
  ensureLoaded();
  let restored = 0;
  for (const card of cards) {
    if (rows.has(card.eventId)) continue;
    rows.set(card.eventId, { listed: true, explicitlyListed: true, updatedAt: new Date().toISOString(), seed: card });
    restored++;
  }
  incomplete = false;
  // Memory is whole now, so a FILE that was not there is written: the restored
  // rows and the changes kept beside it meanwhile. A broken FILE stays as it is.
  if (unreadable || rows.size === 0) return restored;
  if (writeJsonAtomic(FILE, Object.fromEntries(rows), "listing-state") && pending.size > 0) {
    rmSync(PENDING_FILE, { force: true });
    pending.clear();
  }
  return restored;
}

/** `/api/health` section. Counts only: this endpoint is public. */
export function listingStateHealth(): { ok: boolean; unreadable: boolean; rows: number; pending: number } {
  ensureLoaded();
  return {
    ok: unreadable === null && !pendingUnreadable,
    unreadable: unreadable !== null,
    rows: rows.size,
    pending: pending.size,
  };
}

/** Tests only: forget memory so the next call reloads from disk. */
export function __resetListingStateForTest(): void {
  rows.clear();
  pending.clear();
  loaded = false;
  unreadable = null;
  pendingUnreadable = false;
  incomplete = false;
}

/** Set the global-directory listing flag. `seed` (when given) refreshes the card
 *  fallback. `opts.explicitlyListed` marks a deliberate /list action (see ListingRow).
 *  Tombstoned rows are terminal — listing is forced false. */
export function setListed(
  eventId: string,
  listed: boolean,
  seed?: SnapshotCard,
  opts?: { explicitlyListed?: boolean },
): void {
  ensureLoaded();
  const prev = rows.get(eventId);
  if (prev?.tombstoned) listed = false;
  rows.set(eventId, {
    ...prev,
    listed,
    updatedAt: new Date().toISOString(),
    ...(seed ? { seed } : {}),
    ...(opts?.explicitlyListed !== undefined ? { explicitlyListed: opts.explicitlyListed } : {}),
  });
  persist(eventId);
}

/** Tombstone an event — removes it from the directory permanently. */
export function setTombstoned(eventId: string): void {
  ensureLoaded();
  const prev = rows.get(eventId);
  rows.set(eventId, {
    ...prev,
    listed: false,
    tombstoned: true,
    updatedAt: new Date().toISOString(),
  });
  persist(eventId);
}

/** THE SEAM. Snapshot inclusion predicate — default-exclude. */
export function isListedForSnapshot(eventId: string): boolean {
  ensureLoaded();
  const row = rows.get(eventId);
  return !!row && row.listed && !row.tombstoned;
}

/** Listed AND deliberately surfaced via /list (not just auto-seeded at create).
 *  The gate for including an UNREGISTERED event (federated / re-listed legacy). */
export function isExplicitlyListed(eventId: string): boolean {
  ensureLoaded();
  const row = rows.get(eventId);
  return !!row && row.listed && !row.tombstoned && !!row.explicitlyListed;
}

/** Card-seed fallback for an event the builder can't resolve locally. */
export function getListingSeed(eventId: string): SnapshotCard | null {
  ensureLoaded();
  return rows.get(eventId)?.seed ?? null;
}

/** Every currently-listed eventId (listed && !tombstoned) — the full-rebuild
 *  enumeration backstop when the resolution table is thin. */
export function listedEventIds(): string[] {
  ensureLoaded();
  const out: string[] = [];
  for (const [id, row] of rows) if (row.listed && !row.tombstoned) out.push(id);
  return out;
}
