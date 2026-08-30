import type { SeriesManifestBlob } from "@woco/shared";
import { manifestDigest, bytesToHex0x } from "@woco/shared";
import { downloadFromBytes } from "../swarm/bytes.js";

/**
 * Does a series' claimed on-chain event actually belong to that series? (#424)
 *
 * `series.onChainEventId` reaches the server from the creator's own
 * client-signed feed, so it is untrusted input. Without a binding check a
 * creator can name ANOTHER organiser's on-chain event: an authorised sponsor
 * may append slots to any event, so every sale would mint out of the victim's
 * supply while the payment lands with the attacker, and the buyer receives a
 * genuine ticket to the victim's event.
 *
 * ── WHY THE MANIFEST BLOB, AND NOT THE FEED'S `manifestRef` ─────────────────
 *
 * The first version of this fix compared the chain's `manifestRef` against
 * `series.manifestRef`. Both are creator-supplied in the forged case, so an
 * attacker who set BOTH consistently walked straight through it — the check
 * cost them one extra forged field and nothing else.
 *
 * The authoritative value is the digest recomputed from the manifest BLOB:
 *
 *     manifestDigest(blob.signedManifest.body)  ==  onChain.manifestRef
 *
 * `manifestRef` is stamped on chain at registration and cannot be edited, and
 * the blob is content-addressed at `swarmManifestRef`, so a creator cannot make
 * a blob whose digest matches an event they did not register without possessing
 * that event's manifest — which is signed by its real creator's POD key. This
 * is exactly the check `routes/events.ts` confirm-chain already performs; it
 * was simply never applied on the path that spends money.
 *
 * ── COST ────────────────────────────────────────────────────────────────────
 *
 * One Swarm read per manifest ref, EVER. The ref is content-addressed, so its
 * digest is immutable and the result is memoised for the process lifetime.
 * Steady state on the checkout path is a Map hit.
 */

export type BindingVerdict =
  /** Bound, or not checkable for a reason that is not the series' fault. */
  | { ok: true; checked: boolean }
  | {
      ok: false;
      reason: "no-manifest-ref" | "manifest-unresolvable" | "manifest-mismatch" | "series-manifest-inconsistent";
      detail: string;
    };

export interface BindingInput {
  /** The series' declared digest, from the feed. Untrusted; cross-checked only. */
  seriesManifestRef?: string;
  /**
   * Digest recomputed from the manifest blob — the authoritative value.
   * `null` when it could not be resolved (see `resolveManifestDigest`).
   */
  blobManifestDigest?: string | null;
  /**
   * `manifestRef` read from the chain for the claimed event, or null/undefined
   * when the read did not produce one (transport failure).
   */
  onChainManifestRef?: string | null;
}

/**
 * @returns `ok: true, checked: false` only when the CHAIN value is unavailable —
 * a transient condition on a value the creator does not control, so the caller
 * should fail open rather than stop every sale. Every other unresolved case is
 * a refusal: `swarmManifestRef` IS creator-controlled, so treating "could not
 * fetch the blob" as "nothing to check" would hand an attacker the bypass back
 * by pointing the ref at nothing.
 */
export function checkSeriesOnChainBinding(input: BindingInput): BindingVerdict {
  const { seriesManifestRef, blobManifestDigest, onChainManifestRef } = input;

  // No chain value: nothing to compare against, and not the series' fault.
  if (!onChainManifestRef) return { ok: true, checked: false };

  const onChainLower = onChainManifestRef.toLowerCase();

  // A missing series digest is DISQUALIFYING, not "nothing to check".
  //
  // The field is optional in the schema and the checkout's registration gate
  // requires `swarmManifestRef` instead, so treating absence as a skip would
  // let the binding be bypassed by omitting one field — cheaper for an attacker
  // than forging it. Every honest on-chain series has it: `createEventV2`
  // stamps it at creation.
  if (!seriesManifestRef) {
    return {
      ok: false,
      reason: "no-manifest-ref",
      detail: "series declares an on-chain event but no manifestRef to bind it to",
    };
  }

  // The blob is the anchor. Unresolvable means unverifiable, and the ref is
  // creator-controlled, so this fails CLOSED.
  if (!blobManifestDigest) {
    return {
      ok: false,
      reason: "manifest-unresolvable",
      detail: "could not recompute the manifest digest from swarmManifestRef",
    };
  }

  const blobLower = blobManifestDigest.toLowerCase();

  if (blobLower !== onChainLower) {
    return {
      ok: false,
      reason: "manifest-mismatch",
      detail:
        `on-chain event carries manifestRef ${onChainManifestRef.slice(0, 10)}… ` +
        `but the series' own manifest digests to ${blobManifestDigest.slice(0, 10)}…`,
    };
  }

  // The feed agreeing with itself is not required for safety — the blob has
  // already settled it — but a series declaring a digest its own manifest does
  // not produce is malformed, and saying so is more useful than ignoring it.
  if (seriesManifestRef.toLowerCase() !== blobLower) {
    return {
      ok: false,
      reason: "series-manifest-inconsistent",
      detail:
        `series declares manifestRef ${seriesManifestRef.slice(0, 10)}… but its own ` +
        `manifest digests to ${blobManifestDigest.slice(0, 10)}…`,
    };
  }

  return { ok: true, checked: true };
}

/**
 * Digest of the manifest blob at `swarmManifestRef`, or null if it cannot be
 * fetched or parsed.
 *
 * Memoised forever: the ref is content-addressed, so the mapping ref → digest
 * is immutable. Only the FIRST checkout for a given manifest pays a Swarm read.
 * Negative results are deliberately NOT cached — a transient fetch failure must
 * not pin a series into a refusing state for the life of the process.
 */
const _digestByRef = new Map<string, string>();

export async function resolveManifestDigest(swarmManifestRef: string): Promise<string | null> {
  const key = swarmManifestRef.toLowerCase();
  const hit = _digestByRef.get(key);
  if (hit) return hit;

  try {
    const raw = await downloadFromBytes(swarmManifestRef);
    const blob = JSON.parse(raw) as SeriesManifestBlob;
    // Same recomputation confirm-chain performs (routes/events.ts).
    const digest = bytesToHex0x(manifestDigest(blob.signedManifest.body)).toLowerCase();
    _digestByRef.set(key, digest);
    return digest;
  } catch {
    return null;
  }
}

/** Test seam — the memo is process-lifetime state. */
export function _resetManifestDigestCache(): void {
  _digestByRef.clear();
}
