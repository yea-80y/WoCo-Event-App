/**
 * Frozen-vector tests for woco.pod-cert.v1 and woco.pod-cert-challenge.v1.
 * The hardcoded digests, signatures and topics ARE the spec — a change that
 * moves any of them is a format bump, not an edit. Same contract as
 * test/credit/statement.test.ts and test/statement/discipline.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  POD_CERT_CHALLENGE_SIGNING_PREFIX,
  POD_CERT_SIGNING_PREFIX,
  podCertChallengeDigest,
  podCertDigest,
  podCertLogTopic,
  podCertPublicSalt,
  podCertSubjectIndexTopic,
  signPodCert,
  signPodCertChallenge,
  validatePodCertChallengeV1,
  validatePodCertSubjectIndex,
  validatePodCertV1,
  verifyPodCert,
  verifyPodCertChallenge,
  type UnsignedPodCertChallengeV1,
  type UnsignedPodCertV1,
} from "../../src/pod-cert/index.js";
import { signCreditStatement, creditSubject } from "../../src/credit/types.js";

const ISSUER_PRIV = new Uint8Array(32).fill(7);
const ISSUER = bytesToHex(ed25519.getPublicKey(ISSUER_PRIV));
const HOLDER_PRIV = new Uint8Array(32).fill(9);
const HOLDER = bytesToHex(ed25519.getPublicKey(HOLDER_PRIV));
const OTHER_PRIV = new Uint8Array(32).fill(11);
const OTHER = bytesToHex(ed25519.getPublicKey(OTHER_PRIV));
const BADGE = `0x${"ab".repeat(32)}`;

function minimalCert(): UnsignedPodCertV1 {
  return { format: "woco.pod-cert.v1", badge: BADGE, holder: HOLDER, issuedAt: "2026-08-20" };
}

function fullCert(): UnsignedPodCertV1 {
  return {
    ...minimalCert(),
    encPubKey: "cd".repeat(32),
    evidence: ["woco.evidence-report.v1:AAAAAAAAAAAAAAAAAAAAAA"],
  };
}

function challenge(): UnsignedPodCertChallengeV1 {
  return {
    format: "woco.pod-cert-challenge.v1",
    badge: BADGE,
    holder: HOLDER,
    audience: "https://club.example.com",
    nonce: "AAAAAAAAAAAAAAAAAAAAAA",
    expiresAt: 1787000000000,
  };
}

// ---------------------------------------------------------------------------
// Frozen vectors
// ---------------------------------------------------------------------------

test("frozen signing prefixes", () => {
  assert.equal(POD_CERT_SIGNING_PREFIX, "woco-pod-cert-v1\n");
  assert.equal(POD_CERT_CHALLENGE_SIGNING_PREFIX, "woco-pod-cert-challenge-v1\n");
});

test("frozen certificate digest + signature (minimal)", () => {
  assert.equal(bytesToHex(podCertDigest(minimalCert())), "5d767eb953266b3360b132211bedc5a5c72db94ed664f88118382e840e062a0f");
  assert.equal(signPodCert(minimalCert(), ISSUER_PRIV, ISSUER).issuerSig, "6f84ae88e4ef2f7fd7c9e7a4c1f400434e557fe4824fe1aaad655848374fa56b7e234cca6632368218acf9f4bf6e923afccc71111ff2c9c86c60dc0a5e4c350a");
});

test("frozen certificate digest + signature (encPubKey + evidence)", () => {
  assert.equal(bytesToHex(podCertDigest(fullCert())), "d00e102e3f64dbc09864f8eca4749d32befb0ab84016bea120ebc41077131c8b");
  assert.equal(signPodCert(fullCert(), ISSUER_PRIV, ISSUER).issuerSig, "93fe04f654c5d5e073ce0fc9782d159194120db5754351548fa1f90bcbb9d4666083606491bdff124d078c9bbe586157081db14d76423fbaec440579e26e4f0a");
});

test("frozen challenge digest + signature", () => {
  assert.equal(bytesToHex(podCertChallengeDigest(challenge())), "a81213b6c06a9b52256bf5b5646e5f24f766603aa10ae386b6dc81a4f32723dd");
  assert.equal(signPodCertChallenge(challenge(), HOLDER_PRIV).holderSig, "bb85ffdf06d476debbbff0a0692ba6f085f85e4052b70546f400434742ee2bfd44bf19adc6636921ecd97988cc01f8bcda96aca87faea76c6890346ba74c5506");
});

test("frozen topics — the issuer's log and index", () => {
  const salt = podCertPublicSalt();
  assert.equal(bytesToHex(salt), "776f636f2d706f642d636572742d7075626c69632d7631");
  assert.equal(podCertLogTopic(salt, BADGE, 0), "woco/pod-cert/v1/e39645aad348230d3da3b7a2eec1cf1735a2f5df19f449ca1e8f1932aa6b8aff");
  assert.equal(podCertLogTopic(salt, BADGE, 1), "woco/pod-cert/v1/ea6593c6ac38669e1b0151b422c6ae7c52ff04708de0723b4a9006f9518d665a");
  assert.equal(podCertSubjectIndexTopic(salt, 0), "woco/pod-cert/v1/index/d971fbb3771b94c54a789907cb86ffda6f268126d72a2da58849f959721cd9eb");
});

// ---------------------------------------------------------------------------
// The optional field is inside the signature
// ---------------------------------------------------------------------------

test("encPubKey changes the digest — an optional field is signed, not decoration", () => {
  assert.notEqual(bytesToHex(podCertDigest(minimalCert())), bytesToHex(podCertDigest(fullCert())));
});

test("an omitted optional is not the same as an empty one", () => {
  const empty = { ...minimalCert(), evidence: [] };
  assert.notEqual(bytesToHex(podCertDigest(minimalCert())), bytesToHex(podCertDigest(empty)));
});

// ---------------------------------------------------------------------------
// The closed schema
// ---------------------------------------------------------------------------

test("closed schema rejects unknown fields, nulls and wrong shapes", () => {
  const signed = signPodCert(minimalCert(), ISSUER_PRIV, ISSUER);
  assert.ok(validatePodCertV1(signed));

  assert.ok(!validatePodCertV1({ ...signed, extra: 1 }), "unknown top-level field");
  assert.ok(!validatePodCertV1({ ...signed, encPubKey: null }), "null optional");
  assert.ok(!validatePodCertV1({ ...signed, format: "woco.pod-cert.v2" }), "wrong format");
  assert.ok(!validatePodCertV1({ ...signed, badge: BADGE.toUpperCase() }), "uppercase bytes32");
  assert.ok(!validatePodCertV1({ ...signed, badge: BADGE.slice(2) }), "missing 0x");
  assert.ok(!validatePodCertV1({ ...signed, holder: `0x${HOLDER}` }), "0x-prefixed ed25519 key");
  assert.ok(!validatePodCertV1({ ...signed, issuedAt: "20-08-2026" }), "non-ISO date");
  assert.ok(!validatePodCertV1({ ...signed, evidence: ["no-colon"] }), "untagged evidence");
  assert.ok(!validatePodCertV1({ ...signed, evidence: "a:b" }), "evidence not an array");
  assert.ok(!validatePodCertV1({ ...signed, issuerSig: signed.issuerSig.slice(2) }), "short signature");

  const { issuerSig: _s, ...unsigned } = signed;
  assert.ok(!validatePodCertV1(unsigned), "unsigned object is not a certificate");
});

test("a shaped-but-impossible date is accepted, deliberately", () => {
  // Syntactic validation only — see the note on `issuedAt`. Two honest
  // implementations must agree about garbage on a field nothing verifies.
  assert.ok(validatePodCertV1(signPodCert({ ...minimalCert(), issuedAt: "2026-02-30" }, ISSUER_PRIV, ISSUER)));
});

test("challenge closed schema rejects weak nonces and unbounded audiences", () => {
  const signed = signPodCertChallenge(challenge(), HOLDER_PRIV);
  assert.ok(validatePodCertChallengeV1(signed));

  assert.ok(!validatePodCertChallengeV1({ ...signed, nonce: "short" }), "under-entropy nonce");
  assert.ok(!validatePodCertChallengeV1({ ...signed, nonce: `${"A".repeat(21)}+` }), "non-base64url nonce");
  assert.ok(!validatePodCertChallengeV1({ ...signed, audience: "" }), "empty audience");
  assert.ok(!validatePodCertChallengeV1({ ...signed, audience: "a door" }), "audience with a space");
  assert.ok(!validatePodCertChallengeV1({ ...signed, audience: "a".repeat(257) }), "over-long audience");
  assert.ok(!validatePodCertChallengeV1({ ...signed, expiresAt: 0 }), "zero expiry");
  assert.ok(!validatePodCertChallengeV1({ ...signed, expiresAt: 1.5 }), "non-integer expiry");
  assert.ok(!validatePodCertChallengeV1({ ...signed, extra: true }), "unknown field");
});

test("a digest of an unvalidated object never exists", () => {
  assert.throws(() => podCertDigest({ ...minimalCert(), extra: 1 } as unknown as UnsignedPodCertV1));
  assert.throws(() =>
    podCertChallengeDigest({ ...challenge(), nonce: "x" } as unknown as UnsignedPodCertChallengeV1),
  );
});

// ---------------------------------------------------------------------------
// Signing and verification
// ---------------------------------------------------------------------------

test("signing refuses a key that is not the badge's issuer", () => {
  assert.throws(
    () => signPodCert(minimalCert(), OTHER_PRIV, ISSUER),
    /issuer key mismatch/,
    "a certificate signed by the wrong key of a multi-key issuer would fail only at a door",
  );
  assert.throws(() => signPodCertChallenge(challenge(), OTHER_PRIV), /holder key mismatch/);
});

test("verification is bound to the issuer key, the fields and the signature", () => {
  const cert = signPodCert(fullCert(), ISSUER_PRIV, ISSUER);
  assert.ok(verifyPodCert(cert, ISSUER));

  assert.ok(!verifyPodCert(cert, OTHER), "another key's signature does not verify");
  assert.ok(!verifyPodCert({ ...cert, holder: OTHER }, ISSUER), "holder substitution");
  assert.ok(!verifyPodCert({ ...cert, badge: `0x${"cd".repeat(32)}` }, ISSUER), "badge substitution");
  assert.ok(!verifyPodCert({ ...cert, issuedAt: "2020-01-01" }, ISSUER), "backdating");
  assert.ok(!verifyPodCert({ ...cert, encPubKey: "ef".repeat(32) }, ISSUER), "encryption-key swap");
  const { encPubKey: _e, ...stripped } = cert;
  assert.ok(!verifyPodCert(stripped, ISSUER), "dropping a signed optional");
  assert.ok(!verifyPodCert(cert, `0x${ISSUER}`), "malformed issuer key is not a pass");
});

test("challenge verification is bound to the holder key", () => {
  const chal = signPodCertChallenge(challenge(), HOLDER_PRIV);
  assert.ok(verifyPodCertChallenge(chal));
  assert.ok(!verifyPodCertChallenge({ ...chal, nonce: "BBBBBBBBBBBBBBBBBBBBBB" }), "nonce swap");
  assert.ok(!verifyPodCertChallenge({ ...chal, audience: "https://evil.example" }), "audience swap");
  assert.ok(!verifyPodCertChallenge({ ...chal, holder: OTHER }), "holder swap");
});

// ---------------------------------------------------------------------------
// The hard rule, made executable
// ---------------------------------------------------------------------------

test("a rider's self-signed credit can never be read as a certificate", () => {
  // docs/COASTER_CREDITS_PLAN.md: credits must NEVER satisfy a PodGateRule.
  // Format dispatch is the wall, and it is structural — there is no shape of
  // credit statement that reaches the certificate validator.
  const credit = signCreditStatement(
    {
      format: "woco.credit.v1",
      subject: creditSubject("01J4TESTULID00000000000000"),
      holder: HOLDER,
      seq: 1,
      total: 500,
      session: { date: "2026-08-20", count: 1 },
    },
    HOLDER_PRIV,
  );
  assert.ok(!validatePodCertV1(credit));
  assert.ok(!verifyPodCert(credit, HOLDER), "not even against its own signer");
  assert.ok(!verifyPodCert(credit, ISSUER));
});

test("a certificate cannot be replayed as a challenge answer, or the reverse", () => {
  // The two prefixes are what separate them: same fields, different domain.
  const cert = signPodCert(minimalCert(), ISSUER_PRIV, ISSUER);
  const chal = signPodCertChallenge(challenge(), HOLDER_PRIV);
  assert.ok(!verifyPodCertChallenge(cert));
  assert.ok(!verifyPodCert(chal, HOLDER));
  assert.notEqual(
    bytesToHex(podCertDigest(minimalCert())),
    bytesToHex(podCertChallengeDigest(challenge())),
  );
});

// ---------------------------------------------------------------------------
// The issuer's subject index
// ---------------------------------------------------------------------------

test("the index is band-carrying despite its .v1 name", () => {
  assert.ok(
    validatePodCertSubjectIndex({
      format: "woco.pod-cert-index.v1",
      entries: [{ subject: BADGE, band: 2 }],
    }),
  );
  assert.ok(
    !validatePodCertSubjectIndex({ format: "woco.pod-cert-index.v1", subjects: [BADGE] }),
    "the V1 SHAPE must not pass under this type's v1 NAME",
  );
});
