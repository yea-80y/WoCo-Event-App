/**
 * Durable JSON persistence for every `.data` store (#130).
 *
 * It started as the compliance stores' writer and is now the only sanctioned way
 * to write `.data` — `test/data-store-modes.test.ts` fails the build if a store
 * reaches for `writeFileSync` again. It lives under `marketing/` for history
 * alone; nothing in it is marketing-specific.
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

import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Owner-only, applied HERE so it cannot be forgotten per-store.
 *
 * Every file written through this function is a `.data` store holding personal
 * data or replay state — suppression hashes, Art. 7(1) consent evidence, buyer
 * addresses, consumed event ids. They were landing at the process umask (0644 in
 * the container) unless the individual store remembered to chmod itself, and
 * twice it did not: `marketing-lists.json` shipped at 0644, and
 * `consumed-sns-events.json` did too — which stopped being merely untidy when
 * #99 started keying it on recipient email hashes.
 *
 * The mode goes on the TEMP file rather than on the destination, because
 * `renameSync` replaces the inode: whatever mode the temp file carries is the
 * mode the store ends up with. Setting it after the rename would leave a window
 * at 0644, and would silently do nothing on the write that matters — the first
 * one, which creates the file.
 */
const STORE_FILE_MODE = 0o600;
/** Same reasoning one level up; matches the payout stores' existing 0700. */
const STORE_DIR_MODE = 0o700;

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
 * @param opts.pretty indent the JSON. Only for the few stores an operator reads
 *   by hand (`docs/NEXT.md` says `cat .data/storage-ledger.json`); it exists so
 *   moving a store onto this function cannot silently reformat its file.
 * @returns true on success. Callers that are servicing an operator request
 *   (erasure, in particular) MUST check it — reporting "erased" for a write that
 *   did not land is worse than failing loudly.
 */
export function writeJsonAtomic(
  file: string,
  value: unknown,
  tag: string,
  opts: { pretty?: boolean } = {},
): boolean {
  const tmp = `${file}.tmp`;
  let fd: number | undefined;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: STORE_DIR_MODE });

    fd = openSync(tmp, "w", STORE_FILE_MODE);
    writeSync(fd, JSON.stringify(value, null, opts.pretty ? 2 : undefined));
    // `openSync`'s mode argument only applies when it CREATES the file, and it
    // is masked by the umask. A temp file left behind by a crashed write is
    // reopened at whatever mode it already had, so set it explicitly on the
    // descriptor rather than trusting the open.
    fchmodSync(fd, STORE_FILE_MODE);
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
