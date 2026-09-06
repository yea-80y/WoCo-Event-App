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
 *
 * IT IS PER-CHAIN (#489). "Deployed" is a fact about an account ON A CHAIN, and
 * the Kernel moved from Arbitrum Sepolia to Arbitrum One. The addresses are
 * identical on both (CREATE2 reads no chain id), so a Sepolia sighting replayed
 * on Arbitrum One would refuse the counterfactual for an account that is
 * genuinely counterfactual there — locking out every existing passkey user on
 * day one, exactly the accounts for which the fallback IS the mechanism.
 * Records therefore carry the chain they were observed on, and a record from
 * another chain is IGNORED — never deleted and never overwritten, because the
 * move is reversible and a rollback that found the Sepolia sightings erased
 * would reopen the #200 window with nothing left to notice it.
 */

import { readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { KERNEL_CHAIN_ID } from "@woco/shared";
// Generic atomic-JSON writer. It lives under lib/marketing/ for historical
// reasons rather than because it belongs to marketing; auth importing from there
// is a smell worth fixing by relocating it, not by hand-rolling a second writer.
import { writeJsonAtomic } from "../marketing/persist.js";

const DATA_DIR = join(process.cwd(), ".data");
const DEPLOYED_FILE = join(DATA_DIR, "kernel-deployed.json");

interface KernelRecord {
  /** The chain this account was observed deployed on. Absent on records written
   *  before #489, when Arbitrum Sepolia was the only chain a Kernel could be on
   *  — see LEGACY_RECORD_CHAIN_ID. */
  chainId?: number;
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
  version: 3;
  /** `${chainId}:${kernel address}` (lowercase) → record, for anything written
   *  since #489. Pre-#489 entries keep their bare-address key and are read
   *  through the fallback in {@link currentChainRecord}; nothing rewrites them. */
  kernels: Record<string, KernelRecord>;
}

/** v2 (#200) was keyed by bare address and knew nothing about chains. */
interface DeployedStateV2 {
  version: 2;
  kernels: Record<string, KernelRecord>;
}

/**
 * The chain a record with no `chainId` was observed on. There is only one
 * possible answer: Arbitrum Sepolia was the only chain WoCo Kernels ever ran on
 * before #489, so this is a fact about the past, not a default.
 */
const LEGACY_RECORD_CHAIN_ID = 421614;

/** Where a record observed on the CURRENT Kernel chain is written. */
function recordKey(kernelAddress: string): string {
  return `${KERNEL_CHAIN_ID}:${kernelAddress.toLowerCase()}`;
}

/**
 * The record for this Kernel ON THE CURRENT CHAIN, or undefined.
 *
 * THE `chainId` COMPARISON IS THE WHOLE GUARD. The bare-address lookup below
 * deliberately finds pre-#489 records — they are still the right answer when the
 * current chain is the one they were written on (a rollback), and the wrong one
 * otherwise. Deleting the comparison would silently readmit every Sepolia
 * sighting on Arbitrum One.
 */
function currentChainRecord(kernelAddress: string): KernelRecord | undefined {
  const rec = state.kernels[recordKey(kernelAddress)] ?? state.kernels[kernelAddress.toLowerCase()];
  if (!rec) return undefined;
  return (rec.chainId ?? LEGACY_RECORD_CHAIN_ID) === KERNEL_CHAIN_ID ? rec : undefined;
}

/** v1 (#208) stored only the first-observation timestamp per Kernel. */
interface DeployedStateV1 {
  version: 1;
  kernels: Record<string, string>;
}

let state: DeployedState = { version: 3, kernels: {} };
let loaded = false;
let loadFailed = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(readFileSync(DEPLOYED_FILE, "utf-8")) as
      | DeployedState
      | DeployedStateV2
      | DeployedStateV1;
    if (parsed?.kernels && typeof parsed.kernels === "object") {
      if (parsed.version === 1) {
        // The set of known-deployed Kernels carries over as-is; the owner/block
        // fields fill in on each account's next fresh read. Without this the v1
        // file on a live VM would land in the CRITICAL branch below at deploy.
        const kernels: Record<string, KernelRecord> = {};
        for (const [kernel, firstSeen] of Object.entries(parsed.kernels)) {
          if (typeof firstSeen === "string") kernels[kernel] = { firstSeen };
        }
        state = { version: 3, kernels };
      } else {
        // v2 entries keep their bare-address keys and their absent `chainId`.
        // Relabelling them here would be a rewrite of exactly the evidence a
        // rollback needs, and it buys nothing: the read path already knows what
        // a keyless, chainless record means.
        state = { version: 3, kernels: parsed.kernels };
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
 * whatever the caller accepted as current. Recording what is already recorded is
 * a no-op — no fsync for a fact the file already holds.
 */
export function recordKernelOwner(kernelAddress: string, owner: string, block: number): void {
  load();
  const now = new Date().toISOString();
  const existing = currentChainRecord(kernelAddress);
  if (existing && existing.owner === owner.toLowerCase() && existing.block === block) return;
  // Always under the current chain's key: a foreign-chain record for this same
  // address keeps its own key and its own contents.
  state.kernels[recordKey(kernelAddress)] = {
    chainId: KERNEL_CHAIN_ID,
    firstSeen: existing?.firstSeen ?? now,
    owner: owner.toLowerCase(),
    block,
    ownerSeenAt: now,
  };
  persist();
}

/**
 * Has this Kernel ever been observed with an on-chain owner ON THE CURRENT
 * KERNEL CHAIN?
 *
 * True means a counterfactual match is no longer sufficient evidence of control.
 * A sighting from another chain says nothing here: the same address can be
 * deployed on one chain and counterfactual on the next.
 */
export function isKernelKnownDeployed(kernelAddress: string): boolean {
  load();
  return Boolean(currentChainRecord(kernelAddress));
}

/**
 * The owner last accepted as current for this Kernel on the current Kernel
 * chain, and the block it was first seen at — or undefined when nothing ordered
 * is known (never observed on this chain, observed only on another one, or a v1
 * record that predates the block field).
 */
export function getKernelOwnerRecord(
  kernelAddress: string,
): { owner: string; block: number } | undefined {
  load();
  const rec = currentChainRecord(kernelAddress);
  if (!rec || typeof rec.owner !== "string" || typeof rec.block !== "number") return undefined;
  return { owner: rec.owner, block: rec.block };
}

/** Test seam — drops the in-memory set and forces a reload on next access. */
export function _resetKernelDeployedForTests(): void {
  state = { version: 3, kernels: {} };
  loaded = false;
  loadFailed = false;
}
