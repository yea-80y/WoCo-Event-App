/**
 * Canonical like-subject derivation. The like `subject` is an opaque `bytes32`
 * to the server (it only checks the on-chain attestation commits to the same
 * bytes it records), so consistency MUST come from a single client-side helper:
 * if two call sites hash a profile differently, follows fragment across
 * mismatched ids and trending double-counts.
 *
 * For profiles the subject is the ENS namehash of `{label}.woco.eth`. This is
 * NOT a private convention — it is the exact node the L2Registry mints
 * (`sub-ens-contract.ts:computeLabelNode` = `namehash("woco.eth")` then
 * `keccak256(baseNode ++ keccak256(label))`). Reproducing the real node is what
 * lets the live owner be resolved straight from the registry (`ownerOf(node)`),
 * which is the "owner resolved live from chain" invariant the likes design
 * depends on (see docs/EAS_LIKES_HANDOVER.md).
 */

import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, utf8ToBytes, concatBytes } from "@noble/hashes/utils";
import type { Hex0x } from "../types.js";
import { SubjectType, type LikeSubject } from "./types.js";

/** ENS root under which all WoCo names live. */
export const WOCO_ENS_ROOT = "woco.eth" as const;

/**
 * ENS namehash (EIP-137). Labels reaching here are already UTS-46-identity —
 * the registrar validates them to `^[a-z0-9-]+$`, so raw keccak over the bytes
 * matches ethers' normalized `namehash`. Do not feed un-validated labels here.
 */
function namehash(name: string): Uint8Array {
  // Typed as the hash's own output so reassigning the keccak result type-checks
  // under strict generic Uint8Array (ArrayBufferLike vs ArrayBuffer).
  let node: ReturnType<typeof keccak_256> = new Uint8Array(32); // namehash("") = 32 zero bytes
  if (name.length > 0) {
    const labels = name.split(".");
    for (let i = labels.length - 1; i >= 0; i--) {
      const labelHash = keccak_256(utf8ToBytes(labels[i]!));
      node = keccak_256(concatBytes(node, labelHash));
    }
  }
  return node;
}

/** The `bytes32` like-subject for a sub-ENS name (profile, site, or event brand). */
export function profileSubject(label: string): Hex0x {
  const node = namehash(`${label.toLowerCase().trim()}.${WOCO_ENS_ROOT}`);
  return `0x${bytesToHex(node)}` as Hex0x;
}

/** Convenience: the full `LikeSubject` for a named identity. */
export function profileLikeSubject(label: string): LikeSubject {
  return { type: SubjectType.Profile, id: profileSubject(label) };
}
