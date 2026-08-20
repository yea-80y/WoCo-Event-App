// ---------------------------------------------------------------------------
// POD-certificate holdings reader — the second half of the holdings primitive
// (docs/SWARM_SOCIAL_PLAN.md, Gate B). The chain half is `holdings.ts`.
//
// Answers the same question as `getOnChainHolding` — "what does this identity
// hold of POD type M?" — from a different source: an issuer-signed certificate
// the holder PRESENTS, plus a challenge only their key could have answered.
// Both produce a `PodHolding`, and the pure `evaluatePodGate` cannot tell them
// apart, which is the design property worth protecting.
//
// THE ASYMMETRY WITH THE CHAIN ARM, stated because it is easy to mistake for an
// inconsistency: the chain arm proves its manifestRef↔eventId binding ONCE, at
// the write boundary, and is sound only because the gate is then stored in a
// platform-signed feed. This arm re-proves its trust root on EVERY use — the
// manifest is self-verifying against `manifestRef`, so its source does not
// matter. That is what lets Gate B eventually work with no server at all.
// ---------------------------------------------------------------------------

import type {
  CertPodGate, PodHolding, SignedManifestV1, SeriesManifestBlob,
  PodCertPresentation, PodCertChallengeExpectation,
} from "@woco/shared";
import { podCertHoldingFromManifest, resolvePodCertIssuer } from "@woco/shared";
import { downloadFromBytes } from "../swarm/bytes.js";

/**
 * Verified manifests, keyed by `manifestRef` (lowercased).
 *
 * A cache that CANNOT be wrong: the key is the digest of the value, and an
 * entry is only ever written after `resolvePodCertIssuer` has proved that
 * binding. So a poisoned entry would require a keccak collision, not a bad
 * write. In-process and unbounded-by-design in the same sense the chain arm's
 * RPC results are transient — losing it costs one Swarm read.
 */
const verifiedManifests = new Map<string, SignedManifestV1>();

/**
 * Load and verify the badge manifest a certificate gate points at.
 *
 * `swarmManifestRef` is a LOCATION HINT and is treated as one: whatever comes
 * back is only accepted if `keccak256(dagCbor(body))` equals the gate's
 * `manifestRef`. A wrong, stale or hostile ref therefore fails closed instead
 * of shifting trust to whoever wrote the gate.
 *
 * Returns null on any failure — unreachable Swarm, unparseable blob, digest
 * mismatch, signature that is not the issuer's. Callers treat null as "cannot
 * verify", never as "no issuer".
 */
export async function loadVerifiedBadgeManifest(
  gate: CertPodGate,
): Promise<SignedManifestV1 | null> {
  const key = gate.manifestRef.toLowerCase();
  const cached = verifiedManifests.get(key);
  if (cached) return cached;

  let blob: SeriesManifestBlob;
  try {
    blob = JSON.parse(await downloadFromBytes(gate.swarmManifestRef)) as SeriesManifestBlob;
  } catch (err) {
    console.warn(`[pod-cert] manifest read failed for ${key.slice(0, 10)}:`, err);
    return null;
  }

  const manifest = blob?.signedManifest;
  if (!manifest || !resolvePodCertIssuer(manifest, gate.manifestRef)) return null;

  verifiedManifests.set(key, manifest);
  return manifest;
}

/**
 * Read a holder's certificate-sourced holding of one POD type.
 *
 * `presentations` come from the claimer's request; `expect` MUST be rebuilt
 * from server state (the stored challenge record keyed by the presented nonce),
 * never from the request body — the same rule as "the server uses the VERIFIED
 * parentAddress, never one from the body". A presentation that names its own
 * audience, nonce and expiry proves nothing.
 *
 * Never throws: every failure is a zero-count holding.
 */
export async function getCertHolding(
  gate: CertPodGate,
  presentations: readonly PodCertPresentation[],
  expect: PodCertChallengeExpectation,
): Promise<PodHolding> {
  const empty: PodHolding = { manifestRef: gate.manifestRef, count: 0, slots: [] };
  if (!presentations?.length) return empty;

  const manifest = await loadVerifiedBadgeManifest(gate);
  if (!manifest) return empty;

  return podCertHoldingFromManifest(gate.manifestRef, manifest, presentations, expect);
}
