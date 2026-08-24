/**
 * Which email addresses hold a ticket for an event — as HMAC hashes.
 *
 * This is the set `getAttendeeEmailHashes` reads and the broadcast route checks
 * recipients against, and it exists because the server cannot answer that
 * question from anywhere else. On the on-chain rail the contract records a
 * per-ticket burner address, and the claimer's identity lives only inside the
 * sealed order blob, which is encrypted to the organiser. When the v1 claimers
 * feeds were deleted with the v1 rail (#207) the last server-visible source of
 * attendee identity went with them, and the membership check silently became
 * vacuous — see #387.
 *
 * The one moment the server DOES hold the address is Stripe fulfilment: the
 * verified purchase email arrives in the webhook and is already HMAC'd there
 * for consent capture. So membership is not unknowable going forward, only
 * retroactively — this store is that one durable append.
 *
 * WHAT IT IS NOT: a marketing permission. An entry is written for every buyer
 * who supplied an email, whatever they chose about marketing, because it records
 * the CONTRACT relationship — this person bought a ticket to this event — not a
 * consent. That distinction is what makes a service notice ("your event is
 * cancelled") defensible to someone who unsubscribed from marketing: they are
 * still the person who paid for the ticket. Marketing permission lives in
 * `marketing/consent-store.ts` and suppression in `marketing/suppression-store.ts`;
 * this store must never be read as either.
 *
 * MUST survive server restarts. Losing it does not merely degrade a feature: an
 * organiser can no longer prove any recipient is an attendee, so nobody can be
 * told their event was cancelled, and every past attendee is outside the index
 * permanently because the plaintext address is never stored anywhere we can
 * re-derive it from.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../marketing/persist.js";

const DATA_DIR = join(process.cwd(), ".data");
const STORE_FILE = join(DATA_DIR, "event-attendees.json");

interface EventAttendees {
  /** HMAC-SHA256 hashes (hex) of every email that holds a ticket. */
  hashes: string[];
  /** Last append. Retention handle only — nothing reads it yet, but an event
   *  three years past is the obvious first thing to prune and a store with no
   *  timestamp cannot be pruned without re-deriving data we do not have. */
  updatedAt: string;
}

type Store = Record<string, EventAttendees>;

/** eventId → hashes. The Set is the working copy; the file is `string[]`. */
const byEvent = new Map<string, Set<string>>();
const updatedAt = new Map<string, string>();
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(readFileSync(STORE_FILE, "utf-8")) as Store;
    for (const [eventId, rec] of Object.entries(raw)) {
      byEvent.set(eventId, new Set(rec.hashes ?? []));
      if (rec.updatedAt) updatedAt.set(eventId, rec.updatedAt);
    }
    const n = [...byEvent.values()].reduce((a, s) => a + s.size, 0);
    console.log(`[attendee-index] loaded ${n} attendee hashes across ${byEvent.size} events`);
  } catch {
    // Absent on first boot. Deliberately NOT distinguished from unparseable
    // here: `writeJsonAtomic` makes a torn write impossible, so an unreadable
    // file means something outside this process, and the loud path for that is
    // the persistence counter on /api/health rather than refusing to boot.
  }
}

function persist(): void {
  const out: Store = {};
  for (const [eventId, set] of byEvent) {
    out[eventId] = { hashes: [...set], updatedAt: updatedAt.get(eventId) ?? new Date().toISOString() };
  }
  writeJsonAtomic(STORE_FILE, out, "event-attendees");
}

/**
 * Record that `emailHash` holds a ticket for `eventId`.
 *
 * Idempotent — a repeated webhook, a resumed fulfilment or a second ticket on
 * the same order adds nothing and writes nothing, which keeps a retried webhook
 * from rewriting a large file for no reason.
 *
 * @returns true if this was a new attendee.
 */
export function recordAttendeeEmail(eventId: string, emailHash: string, at: string): boolean {
  ensureLoaded();
  let set = byEvent.get(eventId);
  if (!set) {
    set = new Set();
    byEvent.set(eventId, set);
  }
  if (set.has(emailHash)) return false;
  set.add(emailHash);
  updatedAt.set(eventId, at);
  persist();
  return true;
}

/**
 * The proven attendee set for an event.
 *
 * Returns a fresh Set: the caller holds it for the life of a broadcast job and
 * must not be able to mutate the store through it.
 */
export function attendeeEmailHashes(eventId: string): Set<string> {
  ensureLoaded();
  return new Set(byEvent.get(eventId) ?? []);
}

/** Test seam only. */
export function _resetAttendeeIndexForTests(): void {
  byEvent.clear();
  updatedAt.clear();
  loaded = false;
}
