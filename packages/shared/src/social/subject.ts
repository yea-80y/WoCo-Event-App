/**
 * What a like or follow POINTS AT. The statement schema froze `subject` as an
 * opaque bytes32 (`social/types.ts`), which makes derivation the one place
 * fragmentation can happen: two call sites hashing the same profile differently
 * split its followers across mismatched ids, and no indexer can detect it —
 * both sides verify perfectly.
 *
 * There is ONE profile derivation and it lives in `likes/subject.ts`. Callers
 * reach it either through `profileLikeSubject` (which packages it as a
 * `LikeSubject` for the button) or through this module; both are the same
 * function, so the bytes cannot diverge. What this module adds is the EVENT
 * derivation, which previously existed only as an inline `toLowerCase()` at a
 * call site with no width guard, and the follow/like distinction below.
 *
 * These derivations SURVIVE the EAS retirement even though the attestation
 * layer does not. They were never chain-specific: a namehash is a namehash, and
 * `SWARM_SOCIAL_PLAN` commitment 2 (subjects keyed by sovereign identity, never
 * by WoCo-internal ids) is satisfied by both — which is why social needs no
 * equivalent of the commitment-2 exception the credits rail records for
 * coasters. `profileSubject` is imported rather than reimplemented for exactly
 * the fragmentation reason above; `likes/` is superseded as an attestation
 * design, not as an identity derivation.
 */

import type { Hex0x } from "../types.js";
import { profileSubject } from "../likes/subject.js";

/** Frozen wire form for a subject: 0x-prefixed, lowercase, 32 bytes. */
const SUBJECT_RE = /^0x[0-9a-f]{64}$/;

/**
 * The subject for a named identity — an organiser, a creator, a venue brand.
 * The ENS namehash of `{label}.woco.eth`, i.e. the exact node the L2Registry
 * mints, so the live owner stays resolvable from the registry rather than from
 * anything we hold.
 */
export function socialProfileSubject(label: string): Hex0x {
  return profileSubject(label);
}

/**
 * The subject for an event — its `WoCoEventV2` on-chain id, which is already a
 * bytes32 anchored somewhere neither we nor the organiser can quietly restate.
 *
 * Normalises case rather than rejecting it: on-chain ids reach the client from
 * contract reads, receipts and feed payloads, and a mixed-case id that silently
 * derived a DIFFERENT topic would fragment an event's likes with no error
 * anywhere. Anything that is not a bytes32 throws — the frozen topic scheme has
 * no defined behaviour for another width.
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
export function followProfileSubject(label: string): Hex0x {
  return socialProfileSubject(label);
}
