import type { SeriesManifestBlob } from "@woco/shared";
import { manifestV2Digest, validateSignedManifestV2, bytesToHex0x } from "@woco/shared";
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
 * The blob digest does NOT close it either, and it is important not to believe
 * otherwise: `swarmManifestRef` is creator-controlled, so an attacker need not
 * forge a manifest at all — they can point it at the VICTIM's blob, which is
 * public and content-addressed. The recomputed digest then matches the victim's
 * on-chain event exactly. `verifySignedManifest` does not help: it verifies
 * against `issuerPubkey` embedded in the blob, proving someone signed it, not
 * that THIS feed's creator did, and nothing binds that key to `creatorAddress`.
 *
 * THE ANCHOR is therefore the server's OWN registration record — the one input
 * here a creator cannot influence. The blob digest is kept as consistency
 * enforcement (a malformed registration would otherwise sell tickets whose
 * manifests never verify offline), never as the anti-theft anchor.
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
      reason:
        | "no-registration-record"
        | "registration-record-mismatch"
        | "no-manifest-ref"
        | "manifest-unresolvable"
        | "manifest-mismatch"
        | "series-manifest-inconsistent";
      detail: string;
    };

export interface BindingInput {
  /** The on-chain event id the feed claims. Untrusted. */
  claimedOnChainEventId?: string;
  /**
   * The id THIS server recorded when it registered the series
   * (`lookupOnChainEventId`). Server-controlled and unforgeable — this is the
   * anchor that actually holds the guarantee. `null` when no record exists.
   */
  recordedOnChainEventId?: string | null;
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
  const {
    claimedOnChainEventId,
    recordedOnChainEventId,
    seriesManifestRef,
    blobManifestDigest,
    onChainManifestRef,
  } = input;

  // ── THE ANCHOR: this server must have registered the series itself ────────
  //
  // Checked FIRST and independently of the chain, because it is the only input
  // here the creator cannot influence. Everything below is consistency
  // enforcement layered on top.
  //
  // `byEventSeries` is written by `recordOnChainEventId` at registration,
  // before the feed merge, and every legitimate path that sets
  // `onChainEventId` funnels through `confirmSeriesOnChain`. So a series
  // claiming an event this server never registered is not legitimate, whatever
  // its feed says.
  if (claimedOnChainEventId) {
    if (!recordedOnChainEventId) {
      return {
        ok: false,
        reason: "no-registration-record",
        detail: "this server has no registration record for the claimed on-chain event",
      };
    }
    if (recordedOnChainEventId.toLowerCase() !== claimedOnChainEventId.toLowerCase()) {
      return {
        ok: false,
        reason: "registration-record-mismatch",
        detail:
          `series claims ${claimedOnChainEventId.slice(0, 10)}… but this server registered ` +
          `${recordedOnChainEventId.slice(0, 10)}…`,
      };
    }
  }

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
    // The digest recomputation that `confirm-chain` used to perform before that
    // route was deleted (#433). This is now the only place it happens.
    // Closed v2 validation FIRST: a legacy v1 blob (or garbage) resolves to
    // null → the binding check refuses the sale, which is the v1 cutoff doing
    // its job on the money path. Negative results are not cached (below), so a
    // re-published v2 blob at a new ref heals it.
    if (!validateSignedManifestV2(blob?.signedManifest)) return null;
    const digest = bytesToHex0x(manifestV2Digest(blob.signedManifest.body)).toLowerCase();
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
