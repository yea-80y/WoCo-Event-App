/**
 * The DOOR — the pure half of Gate B on the v2 issuer curve: presented
 * certificate + possession challenge in, a `PodHolding` out, no chain and no
 * I/O.
 *
 * This is the second holding source the plan calls for. `evaluatePodGate` is
 * unchanged and unaware: it takes a `PodHolding`, and a `PodHolding` may derive
 * from exactly two places — on-chain slot ownership (`getOnChainHolding`,
 * server) or verified certificates (here). Nothing else. The spoofable
 * collection feed and self-signed credits are not sources and there is no
 * function in this package that would make them one.
 *
 * WHAT CHANGED from `pod-cert/holdings.ts`: the badge's manifest is a
 * `woco.manifest.v2` and the issuer it resolves to is an `IssuerAddress`. The
 * check order, the reason strings and the presence-not-quantity holding are
 * unchanged.
 *
 * WHY THE DOOR IS PURE. A verifier holding the badge manifest, the certificate
 * and the challenge answer needs no network at all: the issuer signature
 * recovers to an address the manifest digest binds to `cert.badge`, and the
 * challenge signature checks against `cert.holder`. First sight costs at most
 * two content-addressed fetches; after that a cached manifest makes offline
 * RE-ENTRY work indefinitely. The one thing an offline door cannot see is a
 * recent policy change — inherent, bounded by the guard's cache TTL, and the
 * OCSP-stapling trade-off stated rather than hidden.
 *
 * EVERY PATH FAILS CLOSED. No branch here returns a pass on a read it could not
 * complete or a field it could not parse.
 *
 * START AT `certHoldingFromManifest` (bottom of this file). It is the only
 * entry point that cannot be handed the wrong issuer, because it does not take
 * one.
 */

import type { PodHolding, Bytes32Hex } from "../pod/types.js";
import type { IssuerAddress } from "../crypto/brands.js";
import { bytesToHex0x } from "../crypto/hex.js";
import { manifestV2Digest } from "../edition/canonical.js";
import { validateSignedManifestV2 } from "../edition/types.js";
import { verifyManifestV2 } from "../edition/merkle.js";
import {
  verifyCertV1,
  verifyCertChallengeV1,
  type CertV1,
  type CertChallengeV1,
} from "./types.js";

/** What a holder presents at a door: the issuer's record, and proof they hold
 *  the key it names. Neither half is worth anything alone. */
export interface CertPresentation {
  cert: CertV1;
  challenge: CertChallengeV1;
}

/** What the door itself chose and must see echoed back, exactly. */
export interface CertChallengeExpectation {
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

export type CertCheck = { ok: true } | { ok: false; reason: string };

/**
 * Resolve the issuer ADDRESS a certificate for `badge` MUST have been signed
 * by, from a badge manifest, proving the binding rather than trusting it.
 *
 * Two things are checked and both matter: that the issuer address really signed
 * this manifest body, and that this body really IS `badge` — `badge` is
 * `keccak256(dagCbor(body))`, so recomputing the digest is what makes the
 * manifest self-verifying and its source irrelevant. Skip the digest check and
 * an attacker supplies their own manifest with their own `issuer`, and every
 * signature after that verifies perfectly against the wrong address.
 *
 * THE V1 LENIENT-KEY HAZARD IS GONE, and its absence is the point. In v1 this
 * function had to refuse a manifest whose `issuerPubkey` was 0x-prefixed or
 * uppercase, because `verifySignedManifest` stripped and case-folded before
 * checking, so such a manifest SELF-VERIFIED and then resolved to a key
 * `verifyPodCert`'s regex refused forever — a dead end that failed closed but
 * said nothing about why. The v2 schema is closed and refusing: `isIssuerAddress`
 * admits only the canonical `0x` + 40 lowercase hex form, so a non-canonical
 * issuer never reaches this function at all.
 *
 * WHAT REPLACES IT is the dispatch refusal, and it is part of the migration
 * rather than incidental: `validateSignedManifestV2` dispatches on
 * `format === "woco.manifest.v2"`, so a legacy `woco.manifest.v1` object — the
 * ed25519-issuer shape — fails here, whole, before any cryptography runs. A v1
 * badge cannot resolve an issuer on this rail and therefore cannot open a v2
 * door. That is the cutoff, enforced structurally.
 *
 * Takes `unknown` rather than a typed manifest: a door is handed whatever a
 * stranger's device or a cache offers, and the closed validator is what turns
 * that into a type. Returns null on any failure — callers treat null as
 * "cannot verify", never as "no issuer".
 */
export function resolveCertIssuer(manifest: unknown, badge: Bytes32Hex): IssuerAddress | null {
  try {
    if (typeof badge !== "string" || !/^0x[0-9a-f]{64}$/.test(badge)) return null;
    if (!validateSignedManifestV2(manifest)) return null;
    // Both sides are canonical lowercase by construction — `bytesToHex0x`
    // emits lowercase and the badge regex above admits nothing else — so this
    // is an exact comparison with no case folding to get wrong.
    if (bytesToHex0x(manifestV2Digest(manifest.body)) !== badge) return null;
    if (!verifyManifestV2(manifest)) return null;
    return manifest.body.issuer;
  } catch {
    return null;
  }
}

/**
 * The full door check for ONE presentation.
 *
 * Order is deliberate: cheap structural equalities before signature maths, so a
 * mismatched presentation costs no curve operations. `issuer` MUST have come
 * from {@link resolveCertIssuer} — an issuer address taken from a directory
 * entry, a gate config or a URL is bound to the badge by nothing, and checking
 * a signature against it is not a check.
 */
export function checkCertPresentation(
  presentation: CertPresentation,
  badge: Bytes32Hex,
  issuer: IssuerAddress,
  expect: CertChallengeExpectation,
): CertCheck {
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

  if (!verifyCertV1(cert, issuer)) {
    return { ok: false, reason: "certificate signature is not the badge issuer's" };
  }
  if (!verifyCertChallengeV1(challenge)) {
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
export function certHolding(
  badge: Bytes32Hex,
  presentations: readonly CertPresentation[],
  issuer: IssuerAddress,
  expect: CertChallengeExpectation,
): PodHolding {
  const held = (presentations ?? []).some((p) => checkCertPresentation(p, badge, issuer, expect).ok);
  return { manifestRef: badge, count: held ? 1 : 0, slots: [] };
}

/**
 * THE ENTRY POINT — derive a holding from presentations and the badge's own
 * manifest, resolving the issuer address internally.
 *
 * Prefer this to {@link certHolding} everywhere. The difference is not
 * convenience: the bare form takes an `issuer: IssuerAddress`, and any address
 * a caller happens to hold — an organiser's wallet address off a directory
 * entry, say — type-checks perfectly as that parameter once branded. Passing
 * one would check every signature against an address bound to the badge by
 * nothing: the misuse the bare form's doc comment can only warn about, and
 * that this signature makes unreachable by never asking for an address at all.
 *
 * Fails closed on an unresolvable manifest (wrong ref, tampered body, signature
 * that is not the issuer's, a legacy `woco.manifest.v1` object): count 0, never
 * a throw. A door handed a bad manifest is a door that cannot verify, which is
 * the same answer as "does not hold".
 */
export function certHoldingFromManifest(
  badge: Bytes32Hex,
  manifest: unknown,
  presentations: readonly CertPresentation[],
  expect: CertChallengeExpectation,
): PodHolding {
  const issuer = resolveCertIssuer(manifest, badge);
  if (!issuer) return { manifestRef: badge, count: 0, slots: [] };
  return certHolding(badge, presentations, issuer, expect);
}
