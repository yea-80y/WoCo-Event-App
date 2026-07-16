/**
 * Global-directory listing state (#37) — the small server-side overlay the
 * chain-log directory design needs.
 *
 * WHY this exists: with the paged directory retired, "is this event listed in the
 * GLOBAL public directory?" no longer has a home — the chain `Registered` log
 * carries no unlist/tombstone event, and it's not organiser content (it's WoCo's
 * curation decision about WoCo's own directory). So it lives here, file-backed like
 * `onchain-events.json` / `likes-index.json`, read through a single seam
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

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SnapshotCard } from "@woco/shared";

const DATA_DIR = join(process.cwd(), ".data");
const FILE = join(DATA_DIR, "event-listing-state.json");

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
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const obj = JSON.parse(readFileSync(FILE, "utf-8")) as Record<string, ListingRow>;
    for (const [k, v] of Object.entries(obj)) rows.set(k, v);
    console.log(`[listing-state] Loaded ${rows.size} event listing rows`);
  } catch {
    // No file yet — default-exclude means an empty overlay is a valid cold start.
  }
}

function persist(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(Object.fromEntries(rows)), "utf-8");
  } catch (err) {
    console.error("[listing-state] Failed to persist:", err);
  }
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
  persist();
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
  persist();
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

/** True if the overlay holds any rows — used to detect a lost/empty overlay file
 *  so the builder can reseed from the last snapshot instead of publishing empty. */
export function hasAnyRows(): boolean {
  ensureLoaded();
  return rows.size > 0;
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
