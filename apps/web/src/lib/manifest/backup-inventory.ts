/**
 * Tri-state backup-inventory read (#166 item 4).
 *
 * The lenient history read this replaces collapsed "the manifest definitively
 * records no backups" and "we could not read the manifest" into one empty
 * array. Every consumer then ACTED on that ambiguity: the nudge told a
 * protected user to add a backup, the studio panel showed "No backup yet" over
 * a transient gateway fault, and — the one that guides an irreversible action —
 * the setup screen silently omitted the "adding a backup resurrects the ones
 * you removed" warning. A security surface may render uncertainty; it may not
 * render a guess.
 *
 * Two statuses, not three, and that is deliberate: the underlying manifest
 * read IS tri-state (`readUserManifestResult`), but "manifest absent" is as
 * definitive an answer about backups as "manifest present" — a manifest that
 * provably does not exist records zero of them. Only "could not read it"
 * remains unanswerable, so that is the only status a consumer must treat as
 * unknown.
 *
 * Store-free like the rest of `manifest/` (S2 freeze rule): the signer comes
 * in as an argument, auth-store owns the secrets and the session memo.
 */

import type { BackupInventoryEntry } from "@woco/shared";
import { readUserManifestResult, type ManifestSigner, type ManifestReadResult } from "./inventory.js";

export type BackupHistoryRead =
  /** Definitive: the manifest was read (or provably does not exist). */
  | { status: "known"; backups: BackupInventoryEntry[] }
  /** No answer — render uncertainty, never "no backups". */
  | { status: "unavailable"; reason?: string };

/**
 * Every backup entry the account has ever recorded, retired ones included —
 * callers filter `revoked` for the live view. Full history because the two
 * warning surfaces (resurrect-on-re-add, retired list) need the retired rows.
 */
export async function readBackupHistoryResult(args: {
  signer: ManifestSigner;
  parentAddress: string;
  /** Test seam — production always takes the real manifest read. */
  readManifest?: (args: { signer: ManifestSigner; parentAddress: string }) => Promise<ManifestReadResult>;
}): Promise<BackupHistoryRead> {
  const read = await (args.readManifest ?? readUserManifestResult)({
    signer: args.signer,
    parentAddress: args.parentAddress,
  });
  if (read.status === "unavailable") return { status: "unavailable", reason: read.reason };
  return { status: "known", backups: read.status === "found" ? read.manifest.backups : [] };
}
