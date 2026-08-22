/**
 * Durable record of what the server has read about each Kernel's owner (#200).
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
 * It also remembers WHICH owner was read and at WHICH block (v2). Reads arrive
 * out of order from a load-balanced RPC, and a lagging replica still names the
 * retired owner after a recovery; the block lets kernel-owner-ordering.ts tell a
 * late answer from a new one. This is memory of chain facts, not authority over
 * them: nothing here can grant access, only withhold it.
 *
 * DURABILITY IS THE POINT. An in-memory record would be cleared by the restart
 * that a deploy performs, and the window would reopen every release — silently,
 * because nothing about a forgotten fact looks like an error. It is written
 * through the same `.data` directory as the revocation state, and belongs on the
 * "must survive restarts" list in CLAUDE.local.md for the same reason that one
 * does.
 *
 * The record is append-only in practice: an account that has been deployed cannot
 * become undeployed, and an owner change only ever moves the record forward to a
 * later block. Losing an entry fails OPEN (the fallback resumes), which is why it
 * is persisted rather than derived on demand.
 */

import { readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
// Generic atomic-JSON writer. It lives under lib/marketing/ for historical
// reasons rather than because it belongs to marketing; auth importing from there
// is a smell worth fixing by relocating it, not by hand-rolling a second writer.
import { writeJsonAtomic } from "../marketing/persist.js";

const DATA_DIR = join(process.cwd(), ".data");
const DEPLOYED_FILE = join(DATA_DIR, "kernel-deployed.json");

interface KernelRecord {
  /** ISO timestamp of the first observation with an on-chain owner. */
  firstSeen: string;
  /** The owner (lowercase) last accepted as current, and the L2 block at which
   *  it was FIRST seen — the last change-point observed. Absent on records
   *  migrated from v1, which knew only that an owner existed. */
  owner?: string;
  block?: number;
  ownerSeenAt?: string;
}

interface DeployedState {
  version: 2;
  /** kernel address (lowercase) → record. */
  kernels: Record<string, KernelRecord>;
}

/** v1 (#208) stored only the first-observation timestamp per Kernel. */
interface DeployedStateV1 {
  version: 1;
  kernels: Record<string, string>;
}

let state: DeployedState = { version: 2, kernels: {} };
let loaded = false;
let loadFailed = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(readFileSync(DEPLOYED_FILE, "utf-8")) as DeployedState | DeployedStateV1;
    if (parsed?.kernels && typeof parsed.kernels === "object") {
      if (parsed.version === 1) {
        // The set of known-deployed Kernels carries over as-is; the owner/block
        // fields fill in on each account's next fresh read. Without this the v1
        // file on a live VM would land in the CRITICAL branch below at deploy.
        const kernels: Record<string, KernelRecord> = {};
        for (const [kernel, firstSeen] of Object.entries(parsed.kernels)) {
          if (typeof firstSeen === "string") kernels[kernel] = { firstSeen };
        }
        state = { version: 2, kernels };
      } else {
        state = { version: 2, kernels: parsed.kernels };
      }
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

    // Quarantine before anything can overwrite it. The next write would otherwise
    // persist the near-empty set straight over the damaged file, making the reset
    // permanent and leaving nothing to diagnose.
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
 * Record that this Kernel was read with a real on-chain owner, at this block.
 *
 * Called only on a definitive, in-order read (kernel-owner-ordering.ts decides
 * that). A `null` owner (provably undeployed), a read error, and a stale read
 * must NOT record anything — the first is the state this guard exists to
 * distinguish from, and the other two know nothing current.
 *
 * The first-observed timestamp is never rewritten; the owner/block advance to
 * whatever the caller accepted as current.
 */
export function recordKernelOwner(kernelAddress: string, owner: string, block: number): void {
  load();
  const key = kernelAddress.toLowerCase();
  const now = new Date().toISOString();
  const existing = state.kernels[key];
  state.kernels[key] = {
    firstSeen: existing?.firstSeen ?? now,
    owner: owner.toLowerCase(),
    block,
    ownerSeenAt: now,
  };
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

/**
 * The owner last accepted as current for this Kernel and the block it was first
 * seen at — or undefined when nothing ordered is known (never observed, or a v1
 * record that predates the block field).
 */
export function getKernelOwnerRecord(
  kernelAddress: string,
): { owner: string; block: number } | undefined {
  load();
  const rec = state.kernels[kernelAddress.toLowerCase()];
  if (!rec || typeof rec.owner !== "string" || typeof rec.block !== "number") return undefined;
  return { owner: rec.owner, block: rec.block };
}

/** Test seam — drops the in-memory set and forces a reload on next access. */
export function _resetKernelDeployedForTests(): void {
  state = { version: 2, kernels: {} };
  loaded = false;
  loadFailed = false;
}
