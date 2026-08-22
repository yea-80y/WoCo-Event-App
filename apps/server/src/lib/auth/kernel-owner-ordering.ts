/**
 * Ordering owner reads (#200): is this answer newer than what we already know?
 *
 * The server decides Kernel-session authority from the account's live ECDSA owner
 * (kernel-owner.ts). It reads that owner at `latest` through a public,
 * load-balanced RPC, and answers from different replicas are not in order — a
 * replica lagging behind a recovery still says the RETIRED owner. Before this
 * module, a read that merely SUCCEEDED was taken as current, so a lagging answer
 * arriving after a fresh one rolled the cache back to the retired key, which then
 * authenticated again for another cache lifetime. #277's re-read-on-rejection made
 * that reachable from every retired-key request: the re-read is exactly the
 * moment a lagging replica gets asked.
 *
 * The fix is not more reads but an ORDER on them. Each read carries the L2 block
 * it was executed at (ArbSys `arbBlockNumber`, fetched in the same `eth_call` as
 * the owner — see kernel-owner.ts), and the server remembers, per Kernel, the
 * block at which it last saw the owner CHANGE. A read that names a DIFFERENT
 * owner from a block no later than that is stale: it predates what we already
 * know, and is discarded — not cached, not acted on. A different owner from a
 * LATER block is a rotation, and the record advances to it. A read naming the
 * SAME owner contradicts nothing and is accepted at any block, so ordinary
 * replica jitter in steady state never refuses anyone.
 *
 * This is memory of chain facts, not authority over them. It can only withhold
 * (discard a stale answer); a grant always comes from a fresh read. It is also
 * what lets an owner legitimately come BACK — web3auth → passkey → web3auth is
 * two rotations at increasing blocks, and the block order admits the second one
 * where a "retired set" would have refused it forever.
 *
 * Pure: the decision takes the record and the read and returns a verdict, so the
 * table below is pinned in tests without an RPC. The I/O wrapper at the bottom
 * is the only part that touches the durable store.
 */

import { getKernelOwnerRecord, recordKernelOwner } from "./kernel-deployed.js";

/** One live read: the owner (lowercase) or `null` for none/unset, and the L2
 *  block the read was executed at. */
export interface OwnerRead {
  owner: string | null;
  block: number;
}

/** What the server remembers about a Kernel's owner: the owner it last accepted
 *  as current, and the block at which that owner was FIRST seen — i.e. the last
 *  change-point we observed. Not advanced by same-owner reads. */
export interface OwnerRecord {
  owner: string;
  block: number;
}

export type OwnerReadJudgement =
  /** Accept the read. `rotation` is true when it names a new owner at a later block. */
  | { verdict: "fresh"; rotation: boolean }
  /** The read predates what we already know — discard it. */
  | { verdict: "stale" };

/**
 * Judge a read against the record.
 *
 *   no record                            → fresh (first observation)
 *   same owner as record                 → fresh, any block (contradicts nothing)
 *   null owner, block > record.block     → fresh (the caller's #208 rule refuses
 *                                           a known-deployed account with no owner;
 *                                           this is not a rotation and the record
 *                                           keeps the last real owner)
 *   null owner, block ≤ record.block     → stale
 *   different owner, block > record.block → fresh, ROTATION
 *   different owner, block ≤ record.block → stale
 *
 * Equality is treated as stale on purpose. One block has one state, so two
 * answers for the same block that disagree cannot both be honest; withholding is
 * the only safe response to an impossible answer.
 */
export function judgeOwnerRead(
  record: OwnerRecord | undefined,
  read: OwnerRead,
): OwnerReadJudgement {
  if (!record) return { verdict: "fresh", rotation: false };
  if (read.owner === record.owner) return { verdict: "fresh", rotation: false };
  if (read.block <= record.block) return { verdict: "stale" };
  return { verdict: "fresh", rotation: read.owner !== null };
}

/**
 * Reconcile a live read with the durable record for `kernelAddress`.
 *
 * Returns the owner to act on, or `"stale"` when the read must be discarded.
 * Persists on first observation of an owner and on rotation — never on a
 * same-owner read, so steady-state traffic costs no disk writes.
 */
export function observeOwnerRead(kernelAddress: string, read: OwnerRead): string | null | "stale" {
  const kernel = kernelAddress.toLowerCase();
  const record = getKernelOwnerRecord(kernel);
  const judged = judgeOwnerRead(record, read);

  if (judged.verdict === "stale") {
    console.warn(
      `[kernel-owner] stale owner read for ${kernel.slice(0, 10)}… discarded: ` +
        `block ${read.block} says ${read.owner ?? "none"}, ` +
        `but owner ${record!.owner.slice(0, 10)}… was already seen at block ${record!.block}`,
    );
    return "stale";
  }

  if (read.owner !== null && (judged.rotation || !record)) {
    if (judged.rotation) {
      // A security-relevant event worth one line: from here on the previous owner
      // is refused, and any later read still naming it is discarded above.
      console.log(
        `[kernel-owner] rotation observed for ${kernel.slice(0, 10)}…: ` +
          `${record!.owner.slice(0, 10)}… → ${read.owner.slice(0, 10)}… at block ${read.block}`,
      );
    }
    recordKernelOwner(kernel, read.owner, read.block);
  }

  return read.owner;
}
