/**
 * The holding-source opt-in: how a stored gate says where its proof comes from,
 * what the write boundary must refuse, and the manifest-taking entry point that
 * makes the wrong issuer key unaskable-for.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  findDuplicateGateManifestRef,
  isCertPodGate,
  isKnownHoldingSource,
  normalizeGate,
  verifyCertPodGateShape,
  verifyPodGateBinding,
} from "../../src/pod/gate.js";
import type { CertPodGate, ChainPodGate, PodGate, ManifestV1Body } from "../../src/pod/types.js";
import { signManifest } from "../../src/pod/merkle.js";
import { bytesToHex0x, manifestDigest } from "../../src/pod/canonical.js";
import {
  podCertHoldingFromManifest,
  signPodCert,
  signPodCertChallenge,
  type PodCertChallengeExpectation,
  type PodCertPresentation,
} from "../../src/pod-cert/index.js";

const ISSUER_PRIV = new Uint8Array(32).fill(7);
const ISSUER = bytesToHex(ed25519.getPublicKey(ISSUER_PRIV));
const HOLDER_PRIV = new Uint8Array(32).fill(9);
const HOLDER = bytesToHex(ed25519.getPublicKey(HOLDER_PRIV));
const ATTACKER_PRIV = new Uint8Array(32).fill(11);
const ATTACKER = bytesToHex(ed25519.getPublicKey(ATTACKER_PRIV));

const NOW = 1787000000000;
const EXPIRES = NOW + 60_000;
const EXPECT: PodCertChallengeExpectation = {
  audience: "events-api.woco-net.com/gate/e1/s1",
  nonce: "AAAAAAAAAAAAAAAAAAAAAA",
  expiresAt: EXPIRES,
  now: NOW,
};

function manifestBody(issuerPubkey: string, totalSupply = 500): ManifestV1Body {
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

const BODY = manifestBody(ISSUER);
const MANIFEST = signManifest(BODY, ISSUER_PRIV);
const BADGE_REF = bytesToHex0x(manifestDigest(BODY));

const SWARM_REF = "ab".repeat(32);

function certGate(over: Partial<CertPodGate> = {}): CertPodGate {
  return { holdingSource: "pod-cert", manifestRef: BADGE_REF, swarmManifestRef: SWARM_REF, ...over };
}

function chainGate(over: Partial<ChainPodGate> = {}): ChainPodGate {
  return {
    manifestRef: BADGE_REF,
    onChainEventId: `0x${"33".repeat(32)}`,
    chainId: 421614,
    ...over,
  };
}

function presentation(): PodCertPresentation {
  return {
    cert: signPodCert(
      { format: "woco.pod-cert.v1", badge: BADGE_REF, holder: HOLDER, issuedAt: "2026-08-20" },
      ISSUER_PRIV,
      ISSUER,
    ),
    challenge: signPodCertChallenge(
      {
        format: "woco.pod-cert-challenge.v1",
        badge: BADGE_REF,
        holder: HOLDER,
        audience: EXPECT.audience,
        nonce: EXPECT.nonce,
        expiresAt: EXPIRES,
      },
      HOLDER_PRIV,
    ),
  };
}

// ---------------------------------------------------------------------------
// Reading the discriminant
// ---------------------------------------------------------------------------

test("an old gate with no holdingSource is a CHAIN gate", () => {
  // The load-bearing compatibility rule. Every gate written before the field
  // existed passed a chain binding check, so this is historically true; and it
  // errs toward the stricter proof, so misreading can only make a gate harder
  // to pass — never let a certificate satisfy chain-configured trust.
  const legacy = chainGate();
  assert.ok(!isCertPodGate(legacy));
  assert.ok(isKnownHoldingSource(legacy));
});

test("an explicit chain gate reads the same as a legacy one", () => {
  const explicit = chainGate({ holdingSource: "chain" });
  assert.ok(!isCertPodGate(explicit));
  assert.ok(isKnownHoldingSource(explicit));
});

test("a certificate gate is recognised", () => {
  assert.ok(isCertPodGate(certGate()));
  assert.ok(isKnownHoldingSource(certGate()));
});

test("a source this build does not know is REFUSED, not treated as chain", () => {
  // A gate written by a newer client must fail closed on an older server.
  // Falling into the chain arm would enforce the wrong proof entirely.
  const future = { manifestRef: BADGE_REF, holdingSource: "attestation-v3" } as unknown as PodGate;
  assert.ok(!isKnownHoldingSource(future));
  assert.ok(!isCertPodGate(future), "and it must not be mistaken for a certificate gate either");
});

// ---------------------------------------------------------------------------
// Write-boundary refusals
// ---------------------------------------------------------------------------

test("a certificate gate that can never open is refused where it is written", () => {
  assert.ok(verifyCertPodGateShape(certGate()).ok);
  assert.ok(verifyCertPodGateShape(certGate({ minCount: 1 })).ok);

  const tooMany = verifyCertPodGateShape({ ...certGate(), minCount: 3 } as CertPodGate);
  assert.ok(!tooMany.ok);
  assert.match(tooMany.error!, /not how many/);

  const firstN = verifyCertPodGateShape({ ...certGate(), maxSlotExclusive: 100 } as CertPodGate);
  assert.ok(!firstN.ok);
  assert.match(firstN.error!, /first-N ordering only exists on the chain rail/);
});

test("a certificate gate with no way to reach its manifest is refused", () => {
  const noRef = verifyCertPodGateShape({ ...certGate(), swarmManifestRef: "" } as CertPodGate);
  assert.ok(!noRef.ok);
  assert.match(noRef.error!, /swarmManifestRef/);

  const badRef = verifyCertPodGateShape({ ...certGate(), swarmManifestRef: `0x${SWARM_REF}` } as CertPodGate);
  assert.ok(!badRef.ok, "0x-prefixed Swarm refs are not this codebase's form");

  const badBadge = verifyCertPodGateShape({ ...certGate(), manifestRef: "nope" } as CertPodGate);
  assert.ok(!badBadge.ok);
});

test("the same badge twice in one group is a duplicate, whatever the sources", () => {
  // Not cosmetic. Enforcement reads ONE holding per manifestRef and matches by
  // manifestRef alone, so the second gate would be evaluated against the first
  // gate's holding — under mode:"all", one proof counted twice.
  const mixed = normalizeGate({ mode: "all", gates: [chainGate(), certGate()] });
  assert.equal(findDuplicateGateManifestRef(mixed), BADGE_REF.toLowerCase());

  const distinct = normalizeGate({
    mode: "any",
    gates: [chainGate(), certGate({ manifestRef: `0x${"44".repeat(32)}` })],
  });
  assert.equal(findDuplicateGateManifestRef(distinct), null, "different badges are a legitimate mixed group");
});

test("the chain binding check is unchanged for chain gates", () => {
  assert.ok(verifyPodGateBinding(chainGate(), BADGE_REF).ok);
  assert.ok(!verifyPodGateBinding(chainGate(), `0x${"99".repeat(32)}`).ok, "wrong POD");
  assert.ok(!verifyPodGateBinding(chainGate(), null).ok, "unregistered event");
});

// ---------------------------------------------------------------------------
// The entry point that cannot be handed the wrong key
// ---------------------------------------------------------------------------

test("a holding derives from the badge's own manifest, with no issuer key passed in", () => {
  const holding = podCertHoldingFromManifest(BADGE_REF, MANIFEST, [presentation()], EXPECT);
  assert.deepEqual(holding, { manifestRef: BADGE_REF, count: 1, slots: [] });
});

test("a manifest that is not this badge's yields nothing, rather than trusting it", () => {
  // The substituted-manifest case, reached through the entry point the server
  // actually uses: the attacker's manifest names the attacker's issuer key, and
  // their certificate verifies perfectly against it — but the digest is not the
  // badge, so no key is ever resolved.
  const attackerManifest = signManifest(manifestBody(ATTACKER), ATTACKER_PRIV);
  const attackerCert: PodCertPresentation = {
    cert: signPodCert(
      { format: "woco.pod-cert.v1", badge: BADGE_REF, holder: HOLDER, issuedAt: "2026-08-20" },
      ATTACKER_PRIV,
      ATTACKER,
    ),
    challenge: presentation().challenge,
  };
  assert.equal(
    podCertHoldingFromManifest(BADGE_REF, attackerManifest, [attackerCert], EXPECT).count,
    0,
  );
});

test("an unreadable manifest is a zero holding, not a throw", () => {
  assert.equal(podCertHoldingFromManifest(BADGE_REF, {} as never, [presentation()], EXPECT).count, 0);
  assert.equal(
    podCertHoldingFromManifest(BADGE_REF, signManifest(manifestBody(ISSUER, 501), ISSUER_PRIV), [presentation()], EXPECT).count,
    0,
    "a genuine manifest for a DIFFERENT badge is still not this badge",
  );
});
