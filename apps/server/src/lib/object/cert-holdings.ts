// ---------------------------------------------------------------------------
// Certificate holdings reader — the second half of the holdings primitive
// (docs/SWARM_SOCIAL_PLAN.md, Gate B; on the v2 issuer curve since PR 5a:
// `woco.cert.v1` under a `woco.manifest.v2` badge, issuer = 20-byte address).
// The chain half is `holdings.ts`.
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
  CertPodGate, PodHolding, SignedManifestV2, SeriesManifestBlob, HolderPubkey,
  CertPresentation, CertChallengeExpectation,
} from "@woco/shared";
import { certHoldingFromManifest, resolveCertIssuer, validateSignedManifestV2 } from "@woco/shared";
import { downloadFromBytes } from "../swarm/bytes.js";

/**
 * Verified manifests, keyed by `manifestRef` (lowercased).
 *
 * A cache that CANNOT be wrong: the key is the digest of the value, and an
 * entry is only ever written after `resolveCertIssuer` has proved that
 * binding. So a poisoned entry would require a keccak collision, not a bad
 * write. In-process and unbounded-by-design in the same sense the chain arm's
 * RPC results are transient — losing it costs one Swarm read.
 */
const verifiedManifests = new Map<string, SignedManifestV2>();

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
 *
 * `bypassCache` exists for ONE caller and is not a performance knob. The cache
 * is keyed by `manifestRef`, so a warm entry answers without ever dereferencing
 * THIS gate's `swarmManifestRef` — which is exactly what the write boundary is
 * checking. Without the bypass, `validatePodGate` would accept a gate whose ref
 * points at nothing whenever some earlier gate had already cached that badge,
 * and the gate would then fail closed forever from the next restart onward:
 * stored, silent, permanently unpassable. Trust is unaffected either way (the
 * digest binding is re-proved on every use), which is what makes the hole quiet
 * enough to need naming.
 */
export async function loadVerifiedBadgeManifest(
  gate: CertPodGate,
  opts: { bypassCache?: boolean } = {},
): Promise<SignedManifestV2 | null> {
  const key = gate.manifestRef.toLowerCase();
  if (!opts.bypassCache) {
    const cached = verifiedManifests.get(key);
    if (cached) return cached;
  }

  let blob: SeriesManifestBlob;
  try {
    blob = JSON.parse(await downloadFromBytes(gate.swarmManifestRef)) as SeriesManifestBlob;
  } catch (err) {
    console.warn(`[pod-cert] manifest read failed for ${key.slice(0, 10)}:`, err);
    return null;
  }

  const manifest = blob?.signedManifest;
  // Closed v2 validation narrows the untrusted bytes; `resolveCertIssuer`
  // re-proves the digest binding + issuer signature. A legacy v1 manifest
  // fails the dispatch — the v1 cutoff on the gate rail.
  if (!manifest || !validateSignedManifestV2(manifest) || !resolveCertIssuer(manifest, gate.manifestRef)) {
    return null;
  }

  verifiedManifests.set(key, manifest);
  return manifest;
}

/**
 * Read a holder's certificate-sourced holding of one POD type.
 *
 * `presentations` come from the claimer's request; `expect` and `expectedHolder`
 * MUST be rebuilt from server state (the stored challenge record keyed by the
 * presented nonce, and the route's verified POD identity), never from the
 * request body — the same rule as "the server uses the VERIFIED parentAddress,
 * never one from the body". A presentation that names its own audience, nonce,
 * expiry and holder proves nothing at all.
 *
 * Never throws: every failure is a zero-count holding.
 */
export async function getCertHolding(
  gate: CertPodGate,
  presentations: readonly CertPresentation[],
  expect: CertChallengeExpectation,
  expectedHolder: HolderPubkey,
): Promise<PodHolding> {
  const empty: PodHolding = { manifestRef: gate.manifestRef, count: 0, slots: [] };
  if (!presentations?.length || !expectedHolder) return empty;

  // The certificate must name the identity actually claiming, not merely SOME
  // identity that holds the badge. Without this a cooperative holder can sign
  // challenges for strangers — credential lending, and the certificate-rail
  // twin of the chain rail's wallet-must-be-the-claimer rule. Enforced here
  // rather than left to each route, so a route cannot forget it.
  const mine = presentations.filter((p) => p?.cert?.holder === expectedHolder);
  if (!mine.length) return empty;

  const manifest = await loadVerifiedBadgeManifest(gate);
  if (!manifest) return empty;

  return certHoldingFromManifest(gate.manifestRef, manifest, mine, expect);
}
