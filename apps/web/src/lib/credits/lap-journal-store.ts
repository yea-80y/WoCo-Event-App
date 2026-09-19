/**
 * Where the lap journal lives on the phone.
 *
 * MEMORY IS THE AUTHORITY for the life of the page, written through to
 * localStorage on every change. Storage can refuse a write (private mode, a
 * full quota) and `cacheSet` swallows that by design; reading the journal back
 * from storage each time would then silently drop the rider's taps. Held in
 * memory they still send — they just would not survive a reload.
 *
 * Keyed by account as well as coaster, under the user-scoped `credit:` prefix:
 * sign-out clears it (see `unsent-laps.ts` for the question asked first).
 */

import { cacheGet, cacheSet } from "../cache/cache.js";
import { parseJournal, pruneJournal, type LapJournal } from "./lap-journal.js";
import { lapJournalKey } from "./unsent-laps.js";

/** How long sealed laps stay in the on-phone list. Their sealed copies outlive it. */
const KEEP_SEALED_MS = 14 * 24 * 60 * 60 * 1000;

export interface LapJournalStore {
  read(): LapJournal;
  write(j: LapJournal): void;
}

export function openLapJournal(parent: string, subject: string): LapJournalStore {
  const key = lapJournalKey(parent, subject);
  let current = pruneJournal(parseJournal(cacheGet<unknown>(key)), Date.now(), KEEP_SEALED_MS);
  return {
    read: () => current,
    write(j) {
      current = j;
      cacheSet(key, j, null);
    },
  };
}
