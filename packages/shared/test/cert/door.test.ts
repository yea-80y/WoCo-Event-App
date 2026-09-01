/**
 * The door: what a verifier does with a presented certificate, and what it
 * must refuse — on the v2 issuer curve. Every test here is fail-closed in
 * shape: a pass is asserted only on the one path where everything checks out.
 *
 * The badge here is a REAL `woco.manifest.v2`, signed by a real derived
 * issuing key, with `badge = keccak256(dagCbor(body))` recomputed rather than
 * declared. Nothing about the door is meaningful against a stub manifest — the
 * digest recomputation is the step that makes the manifest's source irrelevant.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  certHolding,
  certHoldingFromManifest,
  checkCertPresentation,
  resolveCertIssuer,
  type CertChallengeExpectation,
  type CertPresentation,
} from "../../src/cert/holdings.js";
import {
  signCertChallengeV1,
  signCertV1,
  type UnsignedCertChallengeV1,
} from "../../src/cert/types.js";
import { buildManifestV2Message, manifestV2Digest } from "../../src/edition/canonical.js";
import { signManifestV2 } from "../../src/edition/merkle.js";
import type { ManifestV2Body } from "../../src/edition/types.js";
import {
  deriveIssuingKey,
  signPersonalMessage,
} from "../../src/crypto/issuing.js";
import { asHolderPubkey } from "../../src/crypto/brands.js";
import { evaluatePodGate } from "../../src/pod/gate.js";
import { signManifest } from "../../src/pod/merkle.js";
import { bytesToHex0x, manifestDigest } from "../../src/pod/canonical.js";
import type { ManifestV1Body } from "../../src/pod/types.js";

const ISSUING = deriveIssuingKey(`0x${"ab".repeat(32)}`, 0);
const ATTACKER_ISSUING = deriveIssuingKey(`0x${"cd".repeat(32)}`, 0);

const HOLDER_PRIV = new Uint8Array(32).fill(9);
const HOLDER = asHolderPubkey(bytesToHex(ed25519.getPublicKey(HOLDER_PRIV)));
const ATTACKER_PRIV = new Uint8Array(32).fill(11);
const ATTACKER = asHolderPubkey(bytesToHex(ed25519.getPublicKey(ATTACKER_PRIV)));

const NOW = 1787000000000;
const EXPIRES = NOW + 60_000;
const AUDIENCE = "https://club.example.com";
const NONCE = "AAAAAAAAAAAAAAAAAAAAAA";

function badgeManifest(issuer: string, totalSupply = 500): ManifestV2Body {
  return {
    format: "woco.manifest.v2",
    totalSupply,
    issuer: issuer as ManifestV2Body["issuer"],
    metadataRoot: `0x${"22".repeat(32)}`,
    encoding: "cbor-v1",
    treeScheme: "oz-simple-v1",
  };
}

const MANIFEST_BODY = badgeManifest(ISSUING.address);
const BADGE = bytesToHex0x(manifestV2Digest(MANIFEST_BODY));
const SIGNED_MANIFEST = signManifestV2(MANIFEST_BODY, ISSUING.privateKey);

const EXPECT: CertChallengeExpectation = {
  audience: AUDIENCE,
  nonce: NONCE,
  expiresAt: EXPIRES,
  now: NOW,
};

function unsignedChallenge(over: Partial<UnsignedCertChallengeV1> = {}): UnsignedCertChallengeV1 {
  return {
    format: "woco.cert-challenge.v1",
    badge: BADGE,
    holder: HOLDER,
    audience: AUDIENCE,
    nonce: NONCE,
    expiresAt: EXPIRES,
    ...over,
  };
}

function presentation(over: Partial<UnsignedCertChallengeV1> = {}, priv = HOLDER_PRIV): CertPresentation {
  return {
    cert: signCertV1(
      { format: "woco.cert.v1", badge: BADGE, holder: HOLDER, issuedAt: "2026-08-20" },
      ISSUING.privateKey,
      ISSUING.address,
    ),
    challenge: signCertChallengeV1(unsignedChallenge(over), priv),
  };
}

// ---------------------------------------------------------------------------
// Resolving the issuer — the step that makes the manifest's source irrelevant
// ---------------------------------------------------------------------------

test("a badge manifest resolves its own issuer address", () => {
  assert.equal(resolveCertIssuer(SIGNED_MANIFEST, BADGE), ISSUING.address);
});

test("a manifest that is not the badge resolves nothing", () => {
  const other = signManifestV2(badgeManifest(ISSUING.address, 501), ISSUING.privateKey);
  assert.equal(resolveCertIssuer(other, BADGE), null, "digest must equal the badge");
});

test("a manifest whose signature is not its issuer's resolves nothing", () => {
  // Body claims ISSUING (so the digest still equals BADGE) but the attacker's
  // key signed it. `signManifestV2` refuses to build this, so the forgery has
  // to be assembled by hand — which is exactly what an attacker would do.
  const forged = {
    body: MANIFEST_BODY,
    signature: signPersonalMessage(
      buildManifestV2Message(manifestV2Digest(MANIFEST_BODY)),
      ATTACKER_ISSUING.privateKey,
    ),
  };
  assert.equal(resolveCertIssuer(forged, BADGE), null);
});

test("the substituted-manifest attack gets no address at all", () => {
  // The whole attack: supply your own manifest, name your own issuer, and every
  // certificate you signed verifies perfectly — against the wrong address.
  // Recomputing the digest is what closes it.
  const attackerManifest = signManifestV2(
    badgeManifest(ATTACKER_ISSUING.address),
    ATTACKER_ISSUING.privateKey,
  );
  assert.equal(resolveCertIssuer(attackerManifest, BADGE), null);

  const attackerBadge = bytesToHex0x(manifestV2Digest(attackerManifest.body));
  assert.notEqual(attackerBadge, BADGE, "a different issuer is a different badge, by construction");
});

test("a v1 signed manifest resolves nothing — the dispatch refusal IS the cutoff", () => {
  // A `woco.manifest.v1` badge is ed25519-issuer-signed and self-verifies under
  // the v1 verifier. It must not reach any cryptography here: the closed v2
  // schema dispatches on `format` and fails it whole. A v1 badge therefore
  // cannot open a v2 door, which is the migration boundary made structural.
  const v1IssuerPriv = new Uint8Array(32).fill(7);
  const v1Body: ManifestV1Body = {
    format: "woco.manifest.v1",
    eventId: `0x${"11".repeat(32)}`,
    totalSupply: 500,
    issuerPubkey: bytesToHex(ed25519.getPublicKey(v1IssuerPriv)),
    metadataRoot: `0x${"22".repeat(32)}`,
    encoding: "cbor-v1",
    treeScheme: "oz-simple-v1",
  };
  const v1Signed = signManifest(v1Body, v1IssuerPriv);
  const v1Badge = bytesToHex0x(manifestDigest(v1Body));

  assert.equal(resolveCertIssuer(v1Signed, v1Badge), null, "its own badge does not save it");
  assert.equal(resolveCertIssuer(v1Signed, BADGE), null);
});

test("malformed input resolves nothing rather than throwing", () => {
  // Note what is NOT here any more: the v1 rail needed a case for a manifest
  // that self-verified with a 0x-prefixed or uppercase issuer key and then
  // resolved into a dead end. The v2 schema is closed and refusing, so a
  // non-canonical issuer never reaches this function at all.
  assert.equal(resolveCertIssuer(SIGNED_MANIFEST, "not-a-badge"), null);
  assert.equal(resolveCertIssuer(SIGNED_MANIFEST, BADGE.toUpperCase()), null);
  assert.equal(resolveCertIssuer({}, BADGE), null);
  assert.equal(resolveCertIssuer(null, BADGE), null);
  assert.equal(
    resolveCertIssuer({ body: { ...MANIFEST_BODY, issuer: ISSUING.address.toUpperCase() }, signature: SIGNED_MANIFEST.signature }, BADGE),
    null,
    "a non-canonical issuer address is refused, never case-folded",
  );
});

// ---------------------------------------------------------------------------
// The door
// ---------------------------------------------------------------------------

test("a complete, fresh, correctly-addressed presentation passes", () => {
  const check = checkCertPresentation(presentation(), BADGE, ISSUING.address, EXPECT);
  assert.deepEqual(check, { ok: true });
  assert.deepEqual(certHolding(BADGE, [presentation()], ISSUING.address, EXPECT), {
    manifestRef: BADGE,
    count: 1,
    slots: [],
  });
});

test("the door refuses a challenge it did not issue", () => {
  const cases: [string, CertPresentation, RegExp][] = [
    ["another door's audience", presentation({ audience: "https://evil.example" }), /different verifier/],
    ["a nonce it never chose", presentation({ nonce: "BBBBBBBBBBBBBBBBBBBBBB" }), /nonce does not match/],
    ["an expiry it never set", presentation({ expiresAt: EXPIRES + 1 }), /expiry does not match/],
  ];
  for (const [label, p, reason] of cases) {
    const check = checkCertPresentation(p, BADGE, ISSUING.address, EXPECT);
    assert.ok(!check.ok, label);
    assert.match((check as { reason: string }).reason, reason, label);
  }
});

test("an expired challenge is refused even though everything else matches", () => {
  const check = checkCertPresentation(presentation(), BADGE, ISSUING.address, {
    ...EXPECT,
    now: EXPIRES + 1,
  });
  assert.ok(!check.ok);
  assert.match((check as { reason: string }).reason, /expired/);
});

test("a stolen certificate is worthless without its holder's key", () => {
  // The copied-bytes case the design is built around: the attacker holds a
  // perfectly valid certificate naming HOLDER, and can answer nothing with it.
  const stolen: CertPresentation = {
    cert: presentation().cert,
    challenge: signCertChallengeV1(unsignedChallenge({ holder: ATTACKER }), ATTACKER_PRIV),
  };
  const check = checkCertPresentation(stolen, BADGE, ISSUING.address, EXPECT);
  assert.ok(!check.ok);
  assert.match((check as { reason: string }).reason, /different holder/);
  assert.equal(certHolding(BADGE, [stolen], ISSUING.address, EXPECT).count, 0);
});

test("a forged holder signature is refused", () => {
  // `signCertChallengeV1` refuses to sign for a holder it is not, so the only
  // way to reach this case is to forge the signature field directly.
  const good = presentation();
  const forged: CertPresentation = {
    cert: good.cert,
    // Same fields, signed by the attacker's key rather than the holder's.
    challenge: { ...good.challenge, holderSig: signCertChallengeV1(
      unsignedChallenge({ holder: ATTACKER }),
      ATTACKER_PRIV,
    ).holderSig },
  };
  const check = checkCertPresentation(forged, BADGE, ISSUING.address, EXPECT);
  assert.ok(!check.ok);
  assert.match((check as { reason: string }).reason, /challenge signature/);
});

test("a certificate signed by anyone but the badge issuer is refused", () => {
  const attackerCert = signCertV1(
    { format: "woco.cert.v1", badge: BADGE, holder: HOLDER, issuedAt: "2026-08-20" },
    ATTACKER_ISSUING.privateKey,
    ATTACKER_ISSUING.address,
  );
  const check = checkCertPresentation(
    { cert: attackerCert, challenge: presentation().challenge },
    BADGE,
    ISSUING.address,
    EXPECT,
  );
  assert.ok(!check.ok);
  assert.match((check as { reason: string }).reason, /not the badge issuer/);
});

test("a certificate for a different badge is refused at this door", () => {
  const otherBadge = `0x${"33".repeat(32)}`;
  const check = checkCertPresentation(presentation(), otherBadge, ISSUING.address, EXPECT);
  assert.ok(!check.ok);
  assert.match((check as { reason: string }).reason, /different badge/);
});

test("an incomplete presentation is refused rather than crashing", () => {
  assert.ok(!checkCertPresentation({} as never, BADGE, ISSUING.address, EXPECT).ok);
  assert.ok(!checkCertPresentation({ cert: presentation().cert } as never, BADGE, ISSUING.address, EXPECT).ok);
  assert.equal(certHolding(BADGE, [], ISSUING.address, EXPECT).count, 0);
  assert.equal(certHolding(BADGE, undefined as never, ISSUING.address, EXPECT).count, 0);
});

test("one bad presentation does not deny a holder who also presented a good one", () => {
  const held = certHolding(
    BADGE,
    [presentation({ nonce: "BBBBBBBBBBBBBBBBBBBBBB" }), presentation()],
    ISSUING.address,
    EXPECT,
  );
  assert.equal(held.count, 1);
});

// ---------------------------------------------------------------------------
// The entry point that cannot be handed the wrong issuer
// ---------------------------------------------------------------------------

test("the manifest entry point resolves its own issuer and admits a good presentation", () => {
  assert.deepEqual(certHoldingFromManifest(BADGE, SIGNED_MANIFEST, [presentation()], EXPECT), {
    manifestRef: BADGE,
    count: 1,
    slots: [],
  });
});

test("the manifest entry point fails closed on a badge the manifest is not", () => {
  const wrongBadge = `0x${"44".repeat(32)}`;
  assert.deepEqual(certHoldingFromManifest(wrongBadge, SIGNED_MANIFEST, [presentation()], EXPECT), {
    manifestRef: wrongBadge,
    count: 0,
    slots: [],
  });
  // …and on a manifest that cannot be resolved at all, including a v1 one.
  assert.equal(certHoldingFromManifest(BADGE, {}, [presentation()], EXPECT).count, 0);
  assert.equal(certHoldingFromManifest(BADGE, null, [presentation()], EXPECT).count, 0);
});

// ---------------------------------------------------------------------------
// Plugging into the unchanged evaluator
// ---------------------------------------------------------------------------

test("a certificate holding passes the existing pure gate evaluator", () => {
  const holding = certHolding(BADGE, [presentation()], ISSUING.address, EXPECT);
  assert.ok(evaluatePodGate(holding, { manifestRef: BADGE }, NOW));
  assert.ok(evaluatePodGate(holding, { manifestRef: BADGE, minCount: 1 }, NOW));
});

test("a first-N gate is UNSATISFIABLE from certificates, and fails closed", () => {
  // There is no allocation order on this rail, so `slots` is empty and
  // `maxSlotExclusive` filters to zero. That is the correct answer, not a bug:
  // inventing a slot index would let a first-N gate be passed by a number
  // nothing allocated.
  const holding = certHolding(BADGE, [presentation()], ISSUING.address, EXPECT);
  assert.deepEqual(holding.slots, []);
  assert.ok(!evaluatePodGate(holding, { manifestRef: BADGE, maxSlotExclusive: 100 }, NOW));
});

test("a minCount above 1 fails closed — presence is not quantity", () => {
  // Two certificates for the same (badge, holder) — a re-issue after a key
  // rotation, say — must not add up to "holds 2".
  const holding = certHolding(BADGE, [presentation(), presentation()], ISSUING.address, EXPECT);
  assert.equal(holding.count, 1);
  assert.ok(!evaluatePodGate(holding, { manifestRef: BADGE, minCount: 2 }, NOW));
});

test("a gate time window still applies to a certificate holding", () => {
  const holding = certHolding(BADGE, [presentation()], ISSUING.address, EXPECT);
  assert.ok(!evaluatePodGate(holding, { manifestRef: BADGE, notBefore: NOW + 1 }, NOW));
  assert.ok(!evaluatePodGate(holding, { manifestRef: BADGE, notAfter: NOW - 1 }, NOW));
});
