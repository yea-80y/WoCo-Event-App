/**
 * The DOOR — the pure half of Gate B: presented certificate + possession
 * challenge in, a `PodHolding` out, no chain and no I/O.
 *
 * This is the second holding source the plan calls for. `evaluatePodGate` is
 * unchanged and unaware: it takes a `PodHolding`, and a `PodHolding` may now
 * derive from exactly two places — on-chain slot ownership (`getOnChainHolding`,
 * server) or verified POD certificates (here). Nothing else. The spoofable
 * collection feed and self-signed credits are not sources and there is no
 * function in this package that would make them one.
 *
 * WHY THE DOOR IS PURE. A verifier holding the badge manifest, the certificate
 * and the challenge answer needs no network at all: the issuer signature checks
 * against a key the manifest digest binds to `cert.badge`, and the challenge
 * signature checks against `cert.holder`. First sight costs at most two
 * content-addressed fetches; after that a cached manifest makes offline
 * RE-ENTRY work indefinitely. The one thing an offline door cannot see is a
 * recent policy change — inherent, bounded by the guard's cache TTL, and the
 * OCSP-stapling trade-off stated rather than hidden.
 *
 * EVERY PATH FAILS CLOSED. No branch here returns a pass on a read it could not
 * complete or a field it could not parse.
 *
 * START AT `podCertHoldingFromManifest` (bottom of this file). It is the only
 * entry point that cannot be handed the wrong issuer key, because it does not
 * take one.
 */

import type { PodHolding, SignedManifestV1, Bytes32Hex, Hex32 } from "../pod/types.js";
import { manifestDigest, bytesToHex0x } from "../pod/canonical.js";
import { verifySignedManifest } from "../pod/merkle.js";
import {
  verifyPodCert,
  verifyPodCertChallenge,
  type PodCertV1,
  type PodCertChallengeV1,
} from "./types.js";

/** What a holder presents at a door: the issuer's record, and proof they hold
 *  the key it names. Neither half is worth anything alone. */
export interface PodCertPresentation {
  cert: PodCertV1;
  challenge: PodCertChallengeV1;
}

/** What the door itself chose and must see echoed back, exactly. */
export interface PodCertChallengeExpectation {
  /** This door's identity — the same string it put in the challenge. */
  audience: string;
  /** The one-shot nonce this door issued. Replay across USES is the caller's
   *  state to keep (remember spent nonces); replay across DOORS is closed here
   *  by `audience`. */
  nonce: string;
  /** The expiry this door set, echoed exactly. Required rather than merely
   *  bounded: if the door only checked `now < challenge.expiresAt`, the field
   *  would be the holder's to choose, and a signed object whose lifetime its
   *  subject picks is not a door's decision any more. */
  expiresAt: number;
  /** Evaluation clock (Unix ms). Default `Date.now()`. */
  now?: number;
}

export type PodCertCheck = { ok: true } | { ok: false; reason: string };

/**
 * Resolve the issuer key a certificate for `badge` MUST have been signed by,
 * from a badge manifest, proving the binding rather than trusting it.
 *
 * Two things are checked and both matter: that the issuer key really signed
 * this manifest body, and that this body really IS `badge` — `badge` is
 * `keccak256(dagCbor(body))`, so recomputing the digest is what makes the
 * manifest self-verifying and its source irrelevant. Skip the digest check and
 * an attacker supplies their own manifest with their own `issuerPubkey`, and
 * every signature after that verifies perfectly against the wrong key.
 *
 * Returns null on any failure — callers treat null as "cannot verify", never
 * as "no issuer".
 */
export function resolvePodCertIssuer(
  manifest: SignedManifestV1,
  badge: Bytes32Hex,
): Hex32 | null {
  try {
    if (!manifest?.body) return null;
    if (typeof badge !== "string" || !/^0x[0-9a-f]{64}$/.test(badge)) return null;
    if (bytesToHex0x(manifestDigest(manifest.body)).toLowerCase() !== badge) return null;
    if (!verifySignedManifest(manifest)) return null;
    // A manifest can self-verify with a 0x-prefixed or uppercase `issuerPubkey`
    // — `verifySignedManifest` strips and case-folds before checking. Returning
    // that string would resolve into a dead end: `verifyPodCert`'s regex refuses
    // it forever, so the door would fail closed but say nothing about why.
    // Refuse it here, where the failure can still name its cause.
    const issuerPubkey = manifest.body.issuerPubkey;
    if (typeof issuerPubkey !== "string" || !/^[0-9a-f]{64}$/.test(issuerPubkey)) return null;
    return issuerPubkey;
  } catch {
    return null;
  }
}

/**
 * The full door check for ONE presentation.
 *
 * Order is deliberate: cheap structural equalities before signature maths, so a
 * mismatched presentation costs no curve operations. `issuerPubkey` MUST have
 * come from {@link resolvePodCertIssuer} — an issuer key taken from a directory
 * entry, a gate config or a URL is bound to the badge by nothing, and checking
 * a signature against it is not a check.
 */
export function checkPodCertPresentation(
  presentation: PodCertPresentation,
  badge: Bytes32Hex,
  issuerPubkey: Hex32,
  expect: PodCertChallengeExpectation,
): PodCertCheck {
  const { cert, challenge } = presentation ?? {};
  if (!cert || !challenge) return { ok: false, reason: "presentation incomplete" };

  const wanted = typeof badge === "string" ? badge.toLowerCase() : "";
  if (typeof cert.badge !== "string" || cert.badge.toLowerCase() !== wanted) {
    return { ok: false, reason: "certificate is for a different badge" };
  }
  if (typeof challenge.badge !== "string" || challenge.badge.toLowerCase() !== wanted) {
    return { ok: false, reason: "challenge is for a different badge" };
  }
  if (challenge.holder !== cert.holder) {
    return { ok: false, reason: "challenge answers for a different holder" };
  }
  if (challenge.audience !== expect.audience) {
    return { ok: false, reason: "challenge was issued for a different verifier" };
  }
  if (challenge.nonce !== expect.nonce) {
    return { ok: false, reason: "challenge nonce does not match the one issued" };
  }
  if (challenge.expiresAt !== expect.expiresAt) {
    return { ok: false, reason: "challenge expiry does not match the one issued" };
  }
  const now = expect.now ?? Date.now();
  if (now > challenge.expiresAt) return { ok: false, reason: "challenge expired" };

  if (!verifyPodCert(cert, issuerPubkey)) {
    return { ok: false, reason: "certificate signature is not the badge issuer's" };
  }
  if (!verifyPodCertChallenge(challenge)) {
    return { ok: false, reason: "challenge signature does not match the certificate's holder" };
  }
  return { ok: true };
}

/**
 * Derive a `PodHolding` for `badge` from presented certificates.
 *
 * PRESENCE, NOT QUANTITY — `count` is 0 or 1 and `slots` is always empty, and
 * both are deliberate:
 *
 * - There is no allocation order on this rail. Slots are the chain model's
 *   ("the order buyers claimed"), and inventing an index here would let a
 *   `maxSlotExclusive` "first N" gate be satisfied by a number nothing
 *   allocated. Empty slots make such a gate UNSATISFIABLE from certificates,
 *   which is the fail-closed answer: `evaluatePodGate` filters `slots` and
 *   gets zero.
 * - Counting distinct certificates would inflate on re-issuance. An issuer
 *   re-signs when a holder rotates keys or a date was wrong, there is no
 *   per-certificate serial to dedupe on, and `issuedAt` is self-declared. A
 *   gate reading "hold 3" would then be passed by one holder certified three
 *   times.
 *
 * A `minCount > 1` rule therefore cannot pass from this source, and fails
 * closed if one is configured. Rejecting such a gate at its write boundary —
 * where it can be explained to the organiser instead of silently never
 * opening — belongs with the gate config surface, not here.
 *
 * Invalid presentations are DROPPED, not thrown on: a door is handed whatever
 * a stranger's device offers, and one malformed certificate must not deny a
 * holder who presented a good one alongside it.
 */
export function podCertHolding(
  badge: Bytes32Hex,
  presentations: readonly PodCertPresentation[],
  issuerPubkey: Hex32,
  expect: PodCertChallengeExpectation,
): PodHolding {
  const held = (presentations ?? []).some(
    (p) => checkPodCertPresentation(p, badge, issuerPubkey, expect).ok,
  );
  return { manifestRef: badge, count: held ? 1 : 0, slots: [] };
}

/**
 * THE ENTRY POINT — derive a holding from presentations and the badge's own
 * manifest, resolving the issuer key internally.
 *
 * Prefer this to {@link podCertHolding} everywhere. The difference is not
 * convenience: the bare form takes an `issuerPubkey: Hex32`, and
 * `PodDirectoryEntry.issuer` is an unverified display mirror sitting in this
 * same package that type-checks perfectly as that parameter. Passing it would
 * check every signature against a key bound to the badge by nothing — the
 * misuse the bare form's doc comment can only warn about, and that this
 * signature makes unreachable by never asking for a key at all.
 *
 * Fails closed on an unresolvable manifest (wrong ref, tampered body, signature
 * that is not the issuer's): count 0, never a throw. A door handed a bad
 * manifest is a door that cannot verify, which is the same answer as "does not
 * hold".
 */
export function podCertHoldingFromManifest(
  badge: Bytes32Hex,
  manifest: SignedManifestV1,
  presentations: readonly PodCertPresentation[],
  expect: PodCertChallengeExpectation,
): PodHolding {
  const issuerPubkey = resolvePodCertIssuer(manifest, badge);
  if (!issuerPubkey) return { manifestRef: badge, count: 0, slots: [] };
  return podCertHolding(badge, presentations, issuerPubkey, expect);
}
