/**
 * The backup panels' session memo, store-free so it can be tested.
 *
 * Why it exists: a user without a manifest pays a full failed-SOC-probe fan-out
 * on every passive panel mount otherwise. In-memory only — this is decrypted
 * private metadata (guardian addresses) and must not land in localStorage.
 * Concurrent callers (CreatorHome + BackupNudge) share one in-flight read.
 *
 * What it may keep: only a SETTLED answer (#166 item 4, #689). Pinning "couldn't
 * read", or a list read while a newer one could not be ruled out, would show a
 * guess for ten minutes.
 *
 * And never one a write has overtaken. A read can outlast a write: it started
 * before the backup was added, the add dropped the memo, then the read landed
 * and kept the list from BEFORE the add. `drop` therefore also retires every
 * read already running, so none of them can be kept or joined.
 */

import type { BackupHistoryRead } from "./backup-inventory.js";
import type { BackupInventoryEntry } from "@woco/shared";

export class BackupInventoryMemo {
  private memo: { parent: string; at: number; backups: BackupInventoryEntry[] } | null = null;
  private flight: { parent: string; generation: number; promise: Promise<BackupHistoryRead> } | null = null;
  private generation = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** The remembered answer for `parent`, the read already running for it, or a new `load()`. */
  read(parent: string, load: () => Promise<BackupHistoryRead>): Promise<BackupHistoryRead> {
    const m = this.memo;
    if (m && m.parent === parent && this.now() - m.at < this.ttlMs) {
      return Promise.resolve({ status: "known", backups: m.backups, settled: true });
    }
    const f = this.flight;
    if (f && f.parent === parent && f.generation === this.generation) return f.promise;

    const generation = this.generation;
    const promise: Promise<BackupHistoryRead> = load()
      .then((r) => {
        if (r.status === "known" && r.settled && generation === this.generation) {
          this.memo = { parent, at: this.now(), backups: r.backups };
        }
        return r;
      })
      .finally(() => {
        if (this.flight?.promise === promise) this.flight = null;
      });
    this.flight = { parent, generation, promise };
    return promise;
  }

  /** The list changed (a write) or the account did: forget it, and every read
   *  begun before now - a new generation can neither join nor keep one. */
  drop(): void {
    this.memo = null;
    this.generation++;
  }
}
