/**
 * What sign-out would destroy on this device: laps tapped but not sent, and
 * laps counted whose times are not sealed yet.
 *
 * `credit:` is a user-scoped cache prefix on purpose — a shared family device
 * must not show the next person what the last one rode — so signing out wipes
 * the lap journal with it. That is right, and it is also the one way a rider
 * can lose laps they believe are recorded. So the sign-out control asks first.
 *
 * STANDALONE, and it reads the stored journal as plain JSON rather than through
 * `lap-journal.ts`: the sign-out control is in the app shell, and this keeps the
 * credits rail (and what it imports) out of the eager bundle. It errs HIGH — a
 * write still in the air counts as unsent whether or not it was accepted —
 * because the cost of a needless question is a tap, and the cost of a missing
 * one is a rider's laps.
 */

import { cacheGet, cacheKeysByPrefix } from "../cache/cache.js";

export const LAP_JOURNAL_KEY_PREFIX = "credit:journal:";

export function lapJournalKey(parent: string, subject: string): string {
  return `${LAP_JOURNAL_KEY_PREFIX}${parent.toLowerCase()}:${subject}`;
}

export interface UnsentLaps {
  /** Tapped, not in any settled statement. Signing out discards them. */
  waiting: number;
  /** Counted, but their times exist only on this phone. */
  unsealed: number;
}

interface StoredJournalShape {
  waiting?: unknown;
  prepared?: { times?: unknown } | null;
  counted?: unknown;
}

function lengthOf(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

export function unsentLapsOnDevice(parent: string | null | undefined): UnsentLaps {
  const total: UnsentLaps = { waiting: 0, unsealed: 0 };
  if (!parent) return total;
  for (const key of cacheKeysByPrefix(`${LAP_JOURNAL_KEY_PREFIX}${parent.toLowerCase()}:`)) {
    const j = cacheGet<StoredJournalShape>(key);
    if (!j || typeof j !== "object") continue;
    total.waiting += lengthOf(j.waiting) + lengthOf(j.prepared?.times);
    if (Array.isArray(j.counted)) {
      for (const c of j.counted as { sealed?: unknown; times?: unknown }[]) {
        if (c && c.sealed !== true) total.unsealed += lengthOf(c.times);
      }
    }
  }
  return total;
}
