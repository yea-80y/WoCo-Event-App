/**
 * What a like or follow POINTS AT. The statement schema froze `subject` as an
 * opaque bytes32 (`social/types.ts`), which makes derivation the one place
 * fragmentation can happen: two call sites hashing the same profile differently
 * split its followers across mismatched ids, and no indexer can detect it —
 * both sides verify perfectly.
 *
 * A PROFILE IS KEYED BY ITS ADDRESS (owner decision, 2026-09-03). It used to be
 * keyed by the namehash of the holder's `{label}.woco.eth`, which looked like a
 * sovereign identity and is not: three parties other than the holder have power
 * over a name and none over an address.
 *
 *   · WoCo governance — `adminTransfer` reassigns any name, so under namehash
 *     keying it reassigns the AUDIENCE.
 *   · Whoever re-mints — `release` frees a node the same block, so a sniper
 *     inherits the followers the minute a name is free.
 *   · The parent — every subname's meaning is contingent on `woco.eth` custody
 *     and its L1 expiry.
 *
 * That dependence is exactly what `SWARM_SOCIAL_PLAN` commitment 2 exists to
 * forbid, and it is why a third party can now verify follows of an address with
 * no WoCo dependency at all. The cost, accepted deliberately: selling a name no
 * longer carries its audience. That case returns later as a CONSENTED
 * `woco.handover.v1` statement — the old address naming the new one, signed,
 * chain-free — which is strictly better than the implicit handover namehash
 * keying gave equally to a sale, a snipe and an `adminTransfer`.
 *
 * Nothing here imports from `likes/`. That rail is an EAS attestation design
 * being retired, and this module used to borrow its namehash derivation, which
 * was the last edge from live social code into it.
 */

import type { Hex0x } from "../types.js";

/** Frozen wire form for a subject: 0x-prefixed, lowercase, 32 bytes. */
const SUBJECT_RE = /^0x[0-9a-f]{64}$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/**
 * The subject for a person or organisation — the account itself, left-padded to
 * bytes32.
 *
 * Throws on anything that is not an address. The frozen topic scheme has no
 * defined behaviour for another width, and a silently mis-derived subject
 * fragments an audience with no error anywhere — the failure this module exists
 * to prevent.
 */
export function socialProfileSubject(address: string): Hex0x {
  const normalised = address.trim().toLowerCase();
  if (!ADDRESS_RE.test(normalised)) {
    throw new Error(`profile subject must be a 0x-prefixed address, got ${JSON.stringify(address)}`);
  }
  return `0x${"0".repeat(24)}${normalised.slice(2)}` as Hex0x;
}

/**
 * The subject for an event — its `WoCoEventV2` on-chain id, which is already a
 * bytes32 anchored somewhere neither we nor the organiser can quietly restate.
 * A third party binds it to the organiser via `ledger.events(id).organiser`.
 *
 * Normalises case rather than rejecting it: on-chain ids reach the client from
 * contract reads, receipts and feed payloads, and a mixed-case id that silently
 * derived a DIFFERENT topic would fragment an event's likes with no error
 * anywhere. Anything that is not a bytes32 throws.
 */
export function socialEventSubject(onChainEventId: string): Hex0x {
  const normalised = onChainEventId.trim().toLowerCase();
  if (!SUBJECT_RE.test(normalised)) {
    throw new Error(`event subject must be a 0x-prefixed bytes32, got ${JSON.stringify(onChainEventId)}`);
  }
  return normalised as Hex0x;
}

/**
 * A follow targets a sovereign IDENTITY and nothing else — `SWARM_SOCIAL_PLAN`
 * commitment 2's portability promise is that an organiser can carry their
 * audience to another platform, and an audience bound to event ids is not
 * carryable. Following an event would also mean something the product does not:
 * events end, identities do not. Deliberately a separate function from
 * {@link socialProfileSubject} so "follow" has no reachable event overload.
 */
export function followProfileSubject(address: string): Hex0x {
  return socialProfileSubject(address);
}

/**
 * Recover the address a profile subject was derived from, or null if the bytes
 * are not an address-shaped subject.
 *
 * An address subject is its own inverse, which is why display needs no reverse
 * map: a Following list holding only `bytes32` can resolve each entry straight
 * to a profile. Under namehash keying that was impossible — a one-way hash —
 * and it needed a client-side label cache to show a name at all.
 */
export function addressFromProfileSubject(subject: string): Hex0x | null {
  const normalised = subject.trim().toLowerCase();
  if (!SUBJECT_RE.test(normalised)) return null;
  if (normalised.slice(2, 26) !== "0".repeat(24)) return null;
  return `0x${normalised.slice(26)}` as Hex0x;
}
