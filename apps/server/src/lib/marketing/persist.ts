/**
 * Durable JSON persistence for the compliance stores.
 *
 * These files are not caches. Losing `marketing-suppression.json` means mailing
 * people who unsubscribed; losing `marketing-consent.json` destroys the Art. 7(1)
 * evidence for every opt-in it records. Two production failure modes the plain
 * `writeFileSync(...)` in each store did not survive:
 *
 *   1. TORN WRITE. writeFileSync truncates first and then writes. A crash, an
 *      OOM kill or a full disk part-way through leaves a truncated file that
 *      fails JSON.parse on the next boot — and every store's loader treats an
 *      unparseable file as "doesn't exist yet", so the suppression list would
 *      come back EMPTY and silently. Write-temp-then-rename makes the swap
 *      atomic: readers see either the whole old file or the whole new one.
 *
 *   2. SILENT FAILURE. A failed write was a console.error and nothing else, so
 *      the process carried on with in-memory state that disk did not have. The
 *      counters here are surfaced on /api/health so a store that has stopped
 *      persisting alarms instead of waiting to be discovered after a restart.
 *
 * fsync before rename, and fsync the directory after: without the first the
 * rename can be durable while the bytes are not, and without the second the
 * rename itself can be lost on power failure.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** tag → consecutive failures. Zeroed by the next success. */
const failures = new Map<string, number>();
/** tag → last error message, for the health payload. */
const lastError = new Map<string, string>();
/** Monotonic across every store. Lets a caller bracket a multi-store operation
 *  and learn whether ANY write in it failed, without threading a boolean back
 *  through half a dozen signatures. */
let totalFailures = 0;

/** Snapshot for bracketing. See `eraseSubject`. */
export function persistFailureCount(): number {
  return totalFailures;
}

/**
 * Atomically replace `file` with the JSON encoding of `value`.
 *
 * @returns true on success. Callers that are servicing an operator request
 *   (erasure, in particular) MUST check it — reporting "erased" for a write that
 *   did not land is worse than failing loudly.
 */
export function writeJsonAtomic(file: string, value: unknown, tag: string): boolean {
  const tmp = `${file}.tmp`;
  let fd: number | undefined;
  try {
    mkdirSync(dirname(file), { recursive: true });

    fd = openSync(tmp, "w");
    writeSync(fd, JSON.stringify(value));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    renameSync(tmp, file);

    // Durability of the rename itself lives in the directory entry.
    let dir: number | undefined;
    try {
      dir = openSync(dirname(file), "r");
      fsyncSync(dir);
    } catch {
      // Not fatal, and not supported everywhere (Windows). The rename already
      // happened; this only narrows the power-failure window.
    } finally {
      if (dir !== undefined) closeSync(dir);
    }

    failures.delete(tag);
    lastError.delete(tag);
    return true;
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closing down */ }
    }
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }

    const n = (failures.get(tag) ?? 0) + 1;
    const msg = err instanceof Error ? err.message : String(err);
    failures.set(tag, n);
    totalFailures++;
    lastError.set(tag, msg);
    console.error(
      `[${tag}] CRITICAL: could not persist to ${file} (consecutive failures: ${n}). ` +
        `In-memory state is now ahead of disk and WILL be lost on restart:`,
      msg,
    );
    return false;
  }
}

export interface PersistHealth {
  ok: boolean;
  failing: Array<{ store: string; consecutiveFailures: number; lastError: string }>;
}

/** For /api/health — a store that cannot persist must alarm, not wait for a restart. */
export function persistHealth(): PersistHealth {
  const failing = [...failures.entries()].map(([store, consecutiveFailures]) => ({
    store,
    consecutiveFailures,
    lastError: lastError.get(store) ?? "unknown",
  }));
  return { ok: failing.length === 0, failing };
}
