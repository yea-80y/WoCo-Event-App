/**
 * The door: what a verifier does with a presented certificate, and what it
 * must refuse. Every test here is fail-closed in shape — a pass is asserted
 * only on the one path where everything checks out.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  checkPodCertPresentation,
  podCertHolding,
  resolvePodCertIssuer,
  signPodCert,
  signPodCertChallenge,
  type PodCertChallengeExpectation,
  type PodCertPresentation,
  type UnsignedPodCertChallengeV1,
} from "../../src/pod-cert/index.js";
import { evaluatePodGate } from "../../src/pod/gate.js";
import { signManifest, verifySignedManifest } from "../../src/pod/merkle.js";
import { bytesToHex0x, manifestDigest } from "../../src/pod/canonical.js";
import type { ManifestV1Body } from "../../src/pod/types.js";

const ISSUER_PRIV = new Uint8Array(32).fill(7);
const ISSUER = bytesToHex(ed25519.getPublicKey(ISSUER_PRIV));
const HOLDER_PRIV = new Uint8Array(32).fill(9);
const HOLDER = bytesToHex(ed25519.getPublicKey(HOLDER_PRIV));
const ATTACKER_PRIV = new Uint8Array(32).fill(11);
const ATTACKER = bytesToHex(ed25519.getPublicKey(ATTACKER_PRIV));

const NOW = 1787000000000;
const EXPIRES = NOW + 60_000;
const AUDIENCE = "https://club.example.com";
const NONCE = "AAAAAAAAAAAAAAAAAAAAAA";

function badgeManifest(issuerPubkey: string, totalSupply = 500): ManifestV1Body {
  return {
    format: "woco.manifest.v1",
    eventId: `0x${"11".repeat(32)}`,
    totalSupply,
    issuerPubkey,
    metadataRoot: `0x${"22".repeat(32)}`,
    encoding: "cbor-v1",
    treeScheme: "oz-simple-v1",
  };
}

const MANIFEST_BODY = badgeManifest(ISSUER);
const BADGE = bytesToHex0x(manifestDigest(MANIFEST_BODY));
const SIGNED_MANIFEST = signManifest(MANIFEST_BODY, ISSUER_PRIV);

const EXPECT: PodCertChallengeExpectation = {
  audience: AUDIENCE,
  nonce: NONCE,
  expiresAt: EXPIRES,
  now: NOW,
};

function unsignedChallenge(over: Partial<UnsignedPodCertChallengeV1> = {}): UnsignedPodCertChallengeV1 {
  return {
    format: "woco.pod-cert-challenge.v1",
    badge: BADGE,
    holder: HOLDER,
    audience: AUDIENCE,
    nonce: NONCE,
    expiresAt: EXPIRES,
    ...over,
  };
}

function presentation(over: Partial<UnsignedPodCertChallengeV1> = {}, priv = HOLDER_PRIV): PodCertPresentation {
  return {
    cert: signPodCert(
      { format: "woco.pod-cert.v1", badge: BADGE, holder: HOLDER, issuedAt: "2026-08-20" },
      ISSUER_PRIV,
      ISSUER,
    ),
    challenge: signPodCertChallenge(unsignedChallenge(over), priv),
  };
}

// ---------------------------------------------------------------------------
// Resolving the issuer — the step that makes the manifest's source irrelevant
// ---------------------------------------------------------------------------

test("a badge manifest resolves its own issuer key", () => {
  assert.equal(resolvePodCertIssuer(SIGNED_MANIFEST, BADGE), ISSUER);
});

test("a manifest that is not the badge resolves nothing", () => {
  const other = signManifest(badgeManifest(ISSUER, 501), ISSUER_PRIV);
  assert.equal(resolvePodCertIssuer(other, BADGE), null, "digest must equal the badge");
});

test("a manifest whose signature is not its issuer's resolves nothing", () => {
  // Body claims ISSUER (so the digest still equals BADGE) but ATTACKER signed it.
  const forged = { body: MANIFEST_BODY, signature: signManifest(MANIFEST_BODY, ATTACKER_PRIV).signature };
  assert.equal(resolvePodCertIssuer(forged, BADGE), null);
});

test("the substituted-manifest attack gets no key at all", () => {
  // The whole attack: supply your own manifest, name your own issuerPubkey, and
  // every certificate you signed verifies perfectly — against the wrong key.
  // Recomputing the digest is what closes it.
  const attackerManifest = signManifest(badgeManifest(ATTACKER), ATTACKER_PRIV);
  assert.equal(resolvePodCertIssuer(attackerManifest, BADGE), null);

  const attackerBadge = bytesToHex0x(manifestDigest(attackerManifest.body));
  assert.notEqual(attackerBadge, BADGE, "a different issuer is a different badge, by construction");
});

test("a manifest with a nonconforming issuer key resolves nothing, not a dead end", () => {
  // `verifySignedManifest` strips and case-folds, so a 0x-prefixed issuerPubkey
  // self-verifies happily. Returning it would resolve into a key `verifyPodCert`
  // refuses forever — fail-closed, but silent about the cause.
  const body = badgeManifest(`0x${ISSUER}`);
  const badge = bytesToHex0x(manifestDigest(body));
  const signed = signManifest(body, ISSUER_PRIV);
  assert.ok(verifySignedManifest(signed), "it self-verifies — that is the trap");
  assert.equal(resolvePodCertIssuer(signed, badge), null);
});

test("malformed input resolves nothing rather than throwing", () => {
  assert.equal(resolvePodCertIssuer(SIGNED_MANIFEST, "not-a-badge"), null);
  assert.equal(resolvePodCertIssuer(SIGNED_MANIFEST, BADGE.toUpperCase()), null);
  assert.equal(resolvePodCertIssuer({} as never, BADGE), null);
});

// ---------------------------------------------------------------------------
// The door
// ---------------------------------------------------------------------------

test("a complete, fresh, correctly-addressed presentation passes", () => {
  const check = checkPodCertPresentation(presentation(), BADGE, ISSUER, EXPECT);
  assert.deepEqual(check, { ok: true });
  assert.deepEqual(podCertHolding(BADGE, [presentation()], ISSUER, EXPECT), {
    manifestRef: BADGE,
    count: 1,
    slots: [],
  });
});

test("the door refuses a challenge it did not issue", () => {
  const cases: [string, PodCertPresentation, RegExp][] = [
    ["another door's audience", presentation({ audience: "https://evil.example" }), /different verifier/],
    ["a nonce it never chose", presentation({ nonce: "BBBBBBBBBBBBBBBBBBBBBB" }), /nonce does not match/],
    ["an expiry it never set", presentation({ expiresAt: EXPIRES + 1 }), /expiry does not match/],
  ];
  for (const [label, p, reason] of cases) {
    const check = checkPodCertPresentation(p, BADGE, ISSUER, EXPECT);
    assert.ok(!check.ok, label);
    assert.match((check as { reason: string }).reason, reason, label);
  }
});

test("an expired challenge is refused even though everything else matches", () => {
  const check = checkPodCertPresentation(presentation(), BADGE, ISSUER, {
    ...EXPECT,
    now: EXPIRES + 1,
  });
  assert.ok(!check.ok);
  assert.match((check as { reason: string }).reason, /expired/);
});

test("a stolen certificate is worthless without its holder's key", () => {
  // The copied-bytes case the design is built around: ATTACKER holds a perfectly
  // valid certificate naming HOLDER, and can answer nothing with it.
  const stolen: PodCertPresentation = {
    cert: presentation().cert,
    challenge: signPodCertChallenge(unsignedChallenge({ holder: ATTACKER }), ATTACKER_PRIV),
  };
  const check = checkPodCertPresentation(stolen, BADGE, ISSUER, EXPECT);
  assert.ok(!check.ok);
  assert.match((check as { reason: string }).reason, /different holder/);
  assert.equal(podCertHolding(BADGE, [stolen], ISSUER, EXPECT).count, 0);
});

test("a forged holder signature is refused", () => {
  // `signPodCertChallenge` refuses to sign for a holder it is not, so the only
  // way to reach this case is to forge the signature field directly.
  const good = presentation();
  const forged: PodCertPresentation = {
    cert: good.cert,
    // Same fields, signed by the attacker's key rather than the holder's.
    challenge: { ...good.challenge, holderSig: signPodCertChallenge(
      unsignedChallenge({ holder: ATTACKER }),
      ATTACKER_PRIV,
    ).holderSig },
  };
  const check = checkPodCertPresentation(forged, BADGE, ISSUER, EXPECT);
  assert.ok(!check.ok);
  assert.match((check as { reason: string }).reason, /challenge signature/);
});

test("a certificate signed by anyone but the badge issuer is refused", () => {
  const attackerCert = signPodCert(
    { format: "woco.pod-cert.v1", badge: BADGE, holder: HOLDER, issuedAt: "2026-08-20" },
    ATTACKER_PRIV,
    ATTACKER,
  );
  const check = checkPodCertPresentation(
    { cert: attackerCert, challenge: presentation().challenge },
    BADGE,
    ISSUER,
    EXPECT,
  );
  assert.ok(!check.ok);
  assert.match((check as { reason: string }).reason, /not the badge issuer/);
});

test("a certificate for a different badge is refused at this door", () => {
  const otherBadge = `0x${"33".repeat(32)}`;
  const check = checkPodCertPresentation(presentation(), otherBadge, ISSUER, EXPECT);
  assert.ok(!check.ok);
  assert.match((check as { reason: string }).reason, /different badge/);
});

test("an incomplete presentation is refused rather than crashing", () => {
  assert.ok(!checkPodCertPresentation({} as never, BADGE, ISSUER, EXPECT).ok);
  assert.ok(!checkPodCertPresentation({ cert: presentation().cert } as never, BADGE, ISSUER, EXPECT).ok);
  assert.equal(podCertHolding(BADGE, [], ISSUER, EXPECT).count, 0);
  assert.equal(podCertHolding(BADGE, undefined as never, ISSUER, EXPECT).count, 0);
});

test("one bad presentation does not deny a holder who also presented a good one", () => {
  const held = podCertHolding(
    BADGE,
    [presentation({ nonce: "BBBBBBBBBBBBBBBBBBBBBB" }), presentation()],
    ISSUER,
    EXPECT,
  );
  assert.equal(held.count, 1);
});

// ---------------------------------------------------------------------------
// Plugging into the unchanged evaluator
// ---------------------------------------------------------------------------

test("a certificate holding passes the existing pure gate evaluator", () => {
  const holding = podCertHolding(BADGE, [presentation()], ISSUER, EXPECT);
  assert.ok(evaluatePodGate(holding, { manifestRef: BADGE }, NOW));
  assert.ok(evaluatePodGate(holding, { manifestRef: BADGE, minCount: 1 }, NOW));
});

test("a first-N gate is UNSATISFIABLE from certificates, and fails closed", () => {
  // There is no allocation order on this rail, so `slots` is empty and
  // `maxSlotExclusive` filters to zero. That is the correct answer, not a bug:
  // inventing a slot index would let a first-N gate be passed by a number
  // nothing allocated.
  const holding = podCertHolding(BADGE, [presentation()], ISSUER, EXPECT);
  assert.deepEqual(holding.slots, []);
  assert.ok(!evaluatePodGate(holding, { manifestRef: BADGE, maxSlotExclusive: 100 }, NOW));
});

test("a minCount above 1 fails closed — presence is not quantity", () => {
  // Two certificates for the same (badge, holder) — a re-issue after a key
  // rotation, say — must not add up to "holds 2".
  const holding = podCertHolding(BADGE, [presentation(), presentation()], ISSUER, EXPECT);
  assert.equal(holding.count, 1);
  assert.ok(!evaluatePodGate(holding, { manifestRef: BADGE, minCount: 2 }, NOW));
});

test("a gate time window still applies to a certificate holding", () => {
  const holding = podCertHolding(BADGE, [presentation()], ISSUER, EXPECT);
  assert.ok(!evaluatePodGate(holding, { manifestRef: BADGE, notBefore: NOW + 1 }, NOW));
  assert.ok(!evaluatePodGate(holding, { manifestRef: BADGE, notAfter: NOW - 1 }, NOW));
});
