/**
 * Durable record of which Kernels have been observed with an on-chain owner (#200).
 *
 * WHY THIS EXISTS. `isKernelOwner` decides authority by reading the account's live
 * owner. When that read fails it falls back to a counterfactual address match —
 * the Kernel address is CREATE2-derived from the original owner's init data, so
 * the original key matches it forever, including after recovery has rotated the
 * owner away. That fallback is correct for an account that has no on-chain owner
 * yet: nothing else can authenticate it, and only the key deriving the address
 * could ever deploy it. It is NOT correct for an account that has one, because
 * there the counterfactual proves a fact about the account's birth rather than
 * about who controls it now.
 *
 * So the fallback needs to know which case it is in, and the read that would tell
 * it is precisely the read that just failed. This module remembers the answer from
 * when the read did work.
 *
 * DURABILITY IS THE POINT. An in-memory record would be cleared by the restart
 * that a deploy performs, and the window would reopen every release — silently,
 * because nothing about a forgotten fact looks like an error. It is written
 * through the same `.data` directory as the revocation state, and belongs on the
 * "must survive restarts" list in CLAUDE.local.md for the same reason that one
 * does.
 *
 * The record is append-only in practice: an account that has been deployed cannot
 * become undeployed. Losing an entry fails OPEN (the fallback resumes), which is
 * why it is persisted rather than derived on demand.
 */

import { readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
// Generic atomic-JSON writer. It lives under lib/marketing/ for historical
// reasons rather than because it belongs to marketing; auth importing from there
// is a smell worth fixing by relocating it, not by hand-rolling a second writer.
import { writeJsonAtomic } from "../marketing/persist.js";

const DATA_DIR = join(process.cwd(), ".data");
const DEPLOYED_FILE = join(DATA_DIR, "kernel-deployed.json");

interface DeployedState {
  version: 1;
  /** kernel address (lowercase) → ISO timestamp of the first observation. */
  kernels: Record<string, string>;
}

let state: DeployedState = { version: 1, kernels: {} };
let loaded = false;
let loadFailed = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(readFileSync(DEPLOYED_FILE, "utf-8")) as DeployedState;
    if (parsed?.kernels && typeof parsed.kernels === "object") {
      state = { version: 1, kernels: parsed.kernels };
      console.log(`[kernel-deployed] loaded ${Object.keys(state.kernels).length} observed Kernels`);
      return;
    }
    throw new Error("file parsed but holds no kernels object");
  } catch (err) {
    // A missing file is the normal first boot and says nothing.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;

    // Anything else means bytes exist that we cannot use — and the set stays
    // empty, which fails OPEN. That is still the right default (refusing every
    // deployed account over a parse error trades a narrow window for a broad
    // outage), but silence is not: this is the one event that quietly restores
    // the behaviour this module was written to remove.
    console.error(
      `[kernel-deployed] CRITICAL: ${DEPLOYED_FILE} exists but could not be loaded — ` +
        `the counterfactual fallback is active again for every Kernel until this is repaired. ` +
        `Cause: ${(err as Error)?.message ?? err}`,
    );
    loadFailed = true;

    // Quarantine before anything can overwrite it. The next markKernelDeployed
    // would otherwise persist the near-empty set straight over the damaged file,
    // making the reset permanent and leaving nothing to diagnose.
    try {
      const quarantine = `${DEPLOYED_FILE}.corrupt.${Date.now()}`;
      renameSync(DEPLOYED_FILE, quarantine);
      console.error(`[kernel-deployed] preserved the unreadable file at ${quarantine}`);
    } catch (renameErr) {
      console.error("[kernel-deployed] could not quarantine the unreadable file:", renameErr);
    }
  }
}

/** True when the store existed but could not be read — surfaced on /api/health. */
export function kernelDeployedLoadFailed(): boolean {
  load();
  return loadFailed;
}

function persist(): void {
  // ATOMIC, not a plain write. A torn write leaves a truncated file, `load` cannot
  // parse it, the set comes back empty — and an empty set fails OPEN, so the #200
  // window reopens with nothing to observe. writeJsonAtomic writes to a temp file,
  // fsyncs it, renames, and fsyncs the directory, so the file is either the old
  // contents or the new ones. It also sets 0600 on the descriptor rather than
  // trusting the open, which matters because .data modes are not self-maintaining.
  if (!writeJsonAtomic(DEPLOYED_FILE, state, "kernel-deployed")) {
    // In-memory state still holds for this process lifetime, so the guard keeps
    // working until a restart. Loud, because a persistent failure means the
    // window reopens on the next deploy and nothing else would say so.
    console.error("[kernel-deployed] persist failed — the guard will not survive a restart");
  }
}

/**
 * Record that this Kernel was read with a real on-chain owner.
 *
 * Called only on a definitive read. A `null` owner (provably undeployed) and a
 * read error must NOT record anything — the first is the state this guard exists
 * to distinguish from, and the second knows nothing at all.
 */
export function markKernelDeployed(kernelAddress: string): void {
  load();
  const key = kernelAddress.toLowerCase();
  if (state.kernels[key]) return;
  state.kernels[key] = new Date().toISOString();
  persist();
}

/**
 * Has this Kernel ever been observed with an on-chain owner?
 *
 * True means a counterfactual match is no longer sufficient evidence of control.
 */
export function isKernelKnownDeployed(kernelAddress: string): boolean {
  load();
  return Boolean(state.kernels[kernelAddress.toLowerCase()]);
}

/** Test seam — drops the in-memory set and forces a reload on next access. */
export function _resetKernelDeployedForTests(): void {
  state = { version: 1, kernels: {} };
  loaded = false;
  loadFailed = false;
}
