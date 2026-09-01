/**
 * Frozen-vector tests for woco.cert.v1 and woco.cert-challenge.v1 — the v2
 * issuer-curve rail. The hardcoded digests, signatures and topics ARE the
 * spec — a change that moves any of them is a format bump, not an edit. Same
 * contract as test/pod-cert/cert.test.ts and test/crypto/issuing.test.ts.
 *
 * Two curves in one file, deliberately: the ISSUER signs secp256k1 EIP-191
 * personal_sign, the HOLDER still signs ed25519. Every test that pins one must
 * leave the other alone.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  CERT_CHALLENGE_SIGNING_PREFIX,
  CERT_SIGNING_PREFIX,
  buildCertV1Message,
  certChallengeDigest,
  certDigest,
  certLogTopic,
  certPublicSalt,
  certSubjectIndexTopic,
  signCertChallengeV1,
  signCertV1,
  validateCertChallengeV1,
  validateCertSubjectIndex,
  validateCertV1,
  verifyCertChallengeV1,
  verifyCertV1,
  type UnsignedCertChallengeV1,
  type UnsignedCertV1,
} from "../../src/cert/types.js";
import { deriveIssuingKey } from "../../src/crypto/issuing.js";
import {
  asEncryptionPubkey,
  asHolderPubkey,
  asIssuerPubkeyV1,
  type IssuerAddress,
} from "../../src/crypto/brands.js";
import { signPodCert } from "../../src/pod-cert/types.js";
import { signCreditStatement, creditSubject } from "../../src/credit/types.js";

/** The same fixed seed test/crypto/issuing.test.ts pins its golden vectors to. */
const SEED = `0x${"ab".repeat(32)}`;
const ISSUING = deriveIssuingKey(SEED, 0);
const ISSUER: IssuerAddress = ISSUING.address;
/** A second generation of the SAME seed — a rotation, not a different issuer. */
const GEN1 = deriveIssuingKey(SEED, 1);
/** An unrelated issuing key, for the wrong-signer cases. */
const OTHER_ISSUING = deriveIssuingKey(`0x${"cd".repeat(32)}`, 0);

const HOLDER_PRIV = new Uint8Array(32).fill(9);
const HOLDER = asHolderPubkey(bytesToHex(ed25519.getPublicKey(HOLDER_PRIV)));
const OTHER_PRIV = new Uint8Array(32).fill(11);
const OTHER = asHolderPubkey(bytesToHex(ed25519.getPublicKey(OTHER_PRIV)));
const BADGE = `0x${"ab".repeat(32)}`;

/** secp256k1 group order — the malleability twin's modulus. */
const N = secp256k1.Point.Fn.ORDER;

function minimalCert(): UnsignedCertV1 {
  return { format: "woco.cert.v1", badge: BADGE, holder: HOLDER, issuedAt: "2026-08-20" };
}

function fullCert(): UnsignedCertV1 {
  return {
    ...minimalCert(),
    encPubKey: asEncryptionPubkey("cd".repeat(32)),
    evidence: ["woco.evidence-report.v1:AAAAAAAAAAAAAAAAAAAAAA"],
  };
}

function challenge(): UnsignedCertChallengeV1 {
  return {
    format: "woco.cert-challenge.v1",
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
  assert.equal(CERT_SIGNING_PREFIX, "woco-cert-v1\n");
  assert.equal(CERT_CHALLENGE_SIGNING_PREFIX, "woco-cert-challenge-v1\n");
});

test("frozen certificate digest + signature (minimal)", () => {
  assert.equal(bytesToHex(certDigest(minimalCert())), "1e9334dab11cdb7a6941fd129b0f7fa069598a0cc08c60f1b27206513ef61eba");
  assert.equal(signCertV1(minimalCert(), ISSUING.privateKey, ISSUER).issuerSig, "0x77a68b1bb4f63b114a5a10c9ac5e982ccd54d794d7294218afc799696759b9b807d7c085811aa68c9e0fb0b67a8070e2472e390ab64d52663e4f114fe206bad21c");
});

test("frozen certificate digest + signature (encPubKey + evidence)", () => {
  assert.equal(bytesToHex(certDigest(fullCert())), "5bb567e7e02a7dcbd0a7d73b6a7dcf88721af8d81f4ed55831aeccbe8f908db6");
  assert.equal(signCertV1(fullCert(), ISSUING.privateKey, ISSUER).issuerSig, "0xa8ddb76b279e929f59364dc8c17addc7ddcd58ece556dc8304cba8a11c713259148e76fddca1ec10cd2a20baf245220cc1e4ce65cf6c259fc4920ce085ac6ee91b");
});

test("frozen challenge digest + signature", () => {
  assert.equal(bytesToHex(certChallengeDigest(challenge())), "d41ea1c9a6605994a9bacb65606830aa30296ebe3c73925ea88850618fb916d7");
  assert.equal(signCertChallengeV1(challenge(), HOLDER_PRIV).holderSig, "87fe8bb0f1210b9759c3bec08de21d418816a75c6183a901b60c53751c354cb6656b4b34f3ece702f1cce2cf9f34c40df278e8688d7b1fd025d71ad30f801603");
});

test("frozen topics — the issuer's log and index", () => {
  const salt = certPublicSalt();
  assert.equal(bytesToHex(salt), "776f636f2d636572742d7075626c69632d7631");
  assert.equal(certLogTopic(salt, BADGE, 0), "woco/cert/v1/56797ff5519ef148ac27a6c654915e9a904066f8fe631fcf646d26e5c8c7ad5e");
  assert.equal(certLogTopic(salt, BADGE, 1), "woco/cert/v1/759813c6ded0c2798604f75ffe0e75b4fcc859266d9f63573efa1ca583dbaf4f");
  assert.equal(certSubjectIndexTopic(salt, 0), "woco/cert/v1/index/762a09c24139e9c2c98af33157a2eba5d9cbeabaab59e5e379c97f3719362326");
});

// ---------------------------------------------------------------------------
// The personal-sign envelope — why the issuing key never signs a bare digest
// ---------------------------------------------------------------------------

test("the signed message is 79 ASCII bytes and can never be 32", () => {
  // The feed signer personal-signs raw 32-byte SOC digests. An issuing key that
  // personal-signed a bare certificate digest would emit bytes indistinguishable
  // from a SOC signature — cross-protocol forgeable both ways. A length that can
  // never be 32 is what closes it, structurally.
  const message = buildCertV1Message(certDigest(minimalCert()));
  assert.equal(message, `woco-cert-v1\n0x${bytesToHex(certDigest(minimalCert()))}`);
  assert.equal(message.length, 79);
  assert.ok(message.startsWith(CERT_SIGNING_PREFIX), "the domain line separates it from woco-manifest-v2");
  assert.throws(() => buildCertV1Message(new Uint8Array(31)), /32 bytes/);
});

// ---------------------------------------------------------------------------
// The optional field is inside the signature
// ---------------------------------------------------------------------------

test("encPubKey changes the digest — an optional field is signed, not decoration", () => {
  assert.notEqual(bytesToHex(certDigest(minimalCert())), bytesToHex(certDigest(fullCert())));
});

test("an omitted optional is not the same as an empty one", () => {
  const empty = { ...minimalCert(), evidence: [] };
  assert.notEqual(bytesToHex(certDigest(minimalCert())), bytesToHex(certDigest(empty)));
});

// ---------------------------------------------------------------------------
// The closed schema
// ---------------------------------------------------------------------------

test("closed schema rejects unknown fields, nulls and wrong shapes", () => {
  const signed = signCertV1(minimalCert(), ISSUING.privateKey, ISSUER);
  assert.ok(validateCertV1(signed));

  assert.ok(!validateCertV1({ ...signed, extra: 1 }), "unknown top-level field");
  assert.ok(!validateCertV1({ ...signed, encPubKey: null }), "null optional");
  assert.ok(!validateCertV1({ ...signed, encPubKey: undefined }), "an undefined optional is not an omitted one");
  assert.ok(!validateCertV1({ ...signed, format: "woco.cert.v2" }), "wrong format");
  assert.ok(!validateCertV1({ ...signed, badge: BADGE.toUpperCase() }), "uppercase bytes32");
  assert.ok(!validateCertV1({ ...signed, badge: BADGE.slice(2) }), "missing 0x");
  assert.ok(!validateCertV1({ ...signed, holder: `0x${HOLDER}` }), "0x-prefixed ed25519 key");
  assert.ok(!validateCertV1({ ...signed, issuedAt: "20-08-2026" }), "non-ISO date");
  assert.ok(!validateCertV1({ ...signed, evidence: ["no-colon"] }), "untagged evidence");
  assert.ok(!validateCertV1({ ...signed, evidence: "a:b" }), "evidence not an array");
  assert.ok(!validateCertV1({ ...signed, issuerSig: signed.issuerSig.slice(2) }), "unprefixed signature");
  assert.ok(!validateCertV1({ ...signed, issuerSig: signed.issuerSig.slice(0, -2) }), "short signature");
  assert.ok(
    !validateCertV1({ ...signed, issuerSig: signed.issuerSig.toUpperCase() }),
    "uppercase signature — refuse, never case-fold",
  );

  const { issuerSig: _s, ...unsigned } = signed;
  assert.ok(!validateCertV1(unsigned), "unsigned object is not a certificate");
});

test("a shaped-but-impossible date is accepted, deliberately", () => {
  // Syntactic validation only — see the note on `issuedAt`. Two honest
  // implementations must agree about garbage on a field nothing verifies.
  assert.ok(validateCertV1(signCertV1({ ...minimalCert(), issuedAt: "2026-02-30" }, ISSUING.privateKey, ISSUER)));
});

test("challenge closed schema rejects weak nonces and unbounded audiences", () => {
  const signed = signCertChallengeV1(challenge(), HOLDER_PRIV);
  assert.ok(validateCertChallengeV1(signed));

  assert.ok(!validateCertChallengeV1({ ...signed, nonce: "short" }), "under-entropy nonce");
  assert.ok(!validateCertChallengeV1({ ...signed, nonce: `${"A".repeat(21)}+` }), "non-base64url nonce");
  assert.ok(!validateCertChallengeV1({ ...signed, audience: "" }), "empty audience");
  assert.ok(!validateCertChallengeV1({ ...signed, audience: "a door" }), "audience with a space");
  assert.ok(!validateCertChallengeV1({ ...signed, audience: "a".repeat(257) }), "over-long audience");
  assert.ok(!validateCertChallengeV1({ ...signed, expiresAt: 0 }), "zero expiry");
  assert.ok(!validateCertChallengeV1({ ...signed, expiresAt: 1.5 }), "non-integer expiry");
  assert.ok(!validateCertChallengeV1({ ...signed, extra: true }), "unknown field");
});

test("a digest of an unvalidated object never exists", () => {
  assert.throws(() => certDigest({ ...minimalCert(), extra: 1 } as unknown as UnsignedCertV1));
  assert.throws(() =>
    certChallengeDigest({ ...challenge(), nonce: "x" } as unknown as UnsignedCertChallengeV1),
  );
});

// ---------------------------------------------------------------------------
// Signing and verification
// ---------------------------------------------------------------------------

test("signing refuses a key that is not the badge's issuer", () => {
  assert.throws(
    () => signCertV1(minimalCert(), OTHER_ISSUING.privateKey, ISSUER),
    /issuing key mismatch/,
    "a certificate signed by the wrong key of a multi-key issuer would fail only at a door",
  );
  assert.throws(
    () => signCertV1(minimalCert(), GEN1.privateKey, ISSUER),
    /issuing key mismatch/,
    "the wrong GENERATION of the right seed is still the wrong key",
  );
  assert.throws(() => signCertChallengeV1(challenge(), OTHER_PRIV), /holder key mismatch/);
});

test("signing refuses a certificate too large to sit in a log page", () => {
  // `evidence` is bounded in neither entry length nor count, so a certificate
  // can exceed a whole SOC payload by itself — which would push its log page
  // onto the paging path (#315) and destroy the write's read-back atomicity.
  const huge = Array.from({ length: 200 }, (_, i) => `woco.evidence-report.v1:${"A".repeat(40)}${i}`);
  assert.throws(
    () => signCertV1({ ...minimalCert(), evidence: huge }, ISSUING.privateKey, ISSUER),
    /over the 2048-byte limit/,
  );
});

test("verification is bound to the issuer address, the fields and the signature", () => {
  const cert = signCertV1(fullCert(), ISSUING.privateKey, ISSUER);
  assert.ok(verifyCertV1(cert, ISSUER));

  assert.ok(!verifyCertV1(cert, OTHER_ISSUING.address), "another issuer's address does not verify");
  assert.ok(!verifyCertV1({ ...cert, holder: OTHER }, ISSUER), "holder substitution");
  assert.ok(!verifyCertV1({ ...cert, badge: `0x${"cd".repeat(32)}` }, ISSUER), "badge substitution");
  assert.ok(!verifyCertV1({ ...cert, issuedAt: "2020-01-01" }, ISSUER), "backdating");
  assert.ok(!verifyCertV1({ ...cert, encPubKey: "ef".repeat(32) }, ISSUER), "encryption-key swap");
  const { encPubKey: _e, ...stripped } = cert;
  assert.ok(!verifyCertV1(stripped, ISSUER), "dropping a signed optional");
  assert.ok(!verifyCertV1(cert, ISSUER.slice(2) as IssuerAddress), "unprefixed issuer address is not a pass");
  assert.ok(!verifyCertV1(cert, ISSUER.toUpperCase() as IssuerAddress), "checksummed/uppercase address is not a pass");
});

test("a certificate signed by the gen-1 issuing key fails against the gen-0 address", () => {
  // Rotation is a PUBLIC registry statement, not a silent fallback. A door
  // holding the old manifest must refuse the new generation outright rather
  // than accept either — otherwise a rotation would be unobservable.
  const rotated = signCertV1(minimalCert(), GEN1.privateKey, GEN1.address);
  assert.ok(verifyCertV1(rotated, GEN1.address), "it is a perfectly good certificate...");
  assert.ok(!verifyCertV1(rotated, ISSUER), "...for a different issuer address");
  assert.notEqual(GEN1.address, ISSUER, "the same seed, a different identity");
});

test("a malleated high-s issuer signature is refused", () => {
  // secp256k1 signatures have a second valid encoding (s' = n - s, v flipped).
  // Accepting it would mean the same certificate has two byte forms, so nothing
  // downstream could ever key off signature bytes — dedupe, cache, log audit.
  const cert = signCertV1(minimalCert(), ISSUING.privateKey, ISSUER);
  const raw = hexToBytes(cert.issuerSig.slice(2));
  const s = BigInt(`0x${bytesToHex(raw.subarray(32, 64))}`);
  const sHigh = (N - s).toString(16).padStart(64, "0");
  const vFlipped = raw[64] === 27 ? "1c" : "1b";
  const malleated = `0x${bytesToHex(raw.subarray(0, 32))}${sHigh}${vFlipped}`;

  assert.notEqual(malleated, cert.issuerSig);
  assert.ok(validateCertV1({ ...cert, issuerSig: malleated }), "it is still shape-valid — the schema cannot see this");
  assert.ok(
    !verifyCertV1({ ...cert, issuerSig: malleated }, ISSUER),
    "the high-s twin verified — the malleability guard is gone",
  );
  assert.ok(verifyCertV1(cert, ISSUER), "and the original still verifies, so only the twin is refused");
});

test("challenge verification is bound to the holder key", () => {
  const chal = signCertChallengeV1(challenge(), HOLDER_PRIV);
  assert.ok(verifyCertChallengeV1(chal));
  assert.ok(!verifyCertChallengeV1({ ...chal, nonce: "BBBBBBBBBBBBBBBBBBBBBB" }), "nonce swap");
  assert.ok(!verifyCertChallengeV1({ ...chal, audience: "https://evil.example" }), "audience swap");
  assert.ok(!verifyCertChallengeV1({ ...chal, holder: OTHER }), "holder swap");
});

// ---------------------------------------------------------------------------
// Dispatch refusals — what this rail will not read
// ---------------------------------------------------------------------------

test("a well-formed woco.pod-cert.v1 certificate is refused — dispatch, not signature", () => {
  // The v1 rail's certificates are ed25519-issuer-signed and conform to their
  // own closed schema perfectly. They must not half-parse here: `format`
  // dispatch fails them whole, before any curve is chosen. That refusal IS the
  // curve migration's cutoff.
  const v1IssuerPriv = new Uint8Array(32).fill(7);
  const v1Issuer = asIssuerPubkeyV1(bytesToHex(ed25519.getPublicKey(v1IssuerPriv)));
  const legacy = signPodCert(
    { format: "woco.pod-cert.v1", badge: BADGE, holder: HOLDER, issuedAt: "2026-08-20" },
    v1IssuerPriv,
    v1Issuer,
  );

  assert.ok(!validateCertV1(legacy), "a v1 certificate is not a v2 certificate");
  assert.ok(!verifyCertV1(legacy, ISSUER));
  assert.ok(
    !verifyCertV1({ ...legacy, format: "woco.cert.v1" }, ISSUER),
    "nor is one with its format field rewritten — the signature is over the format too",
  );
});

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
  assert.ok(!validateCertV1(credit));
  assert.ok(!verifyCertV1(credit, ISSUER));
});

test("a certificate cannot be replayed as a challenge answer, or the reverse", () => {
  // The two prefixes are what separate them: same fields, different domain.
  // The curves differ too now, which is belt-and-braces, not the argument.
  const cert = signCertV1(minimalCert(), ISSUING.privateKey, ISSUER);
  const chal = signCertChallengeV1(challenge(), HOLDER_PRIV);
  assert.ok(!verifyCertChallengeV1(cert));
  assert.ok(!verifyCertV1(chal, ISSUER));
  assert.notEqual(
    bytesToHex(certDigest(minimalCert())),
    bytesToHex(certChallengeDigest(challenge())),
  );
});

// ---------------------------------------------------------------------------
// The issuer's subject index
// ---------------------------------------------------------------------------

test("the index is band-carrying despite its .v1 name", () => {
  assert.ok(
    validateCertSubjectIndex({
      format: "woco.cert-index.v1",
      entries: [{ subject: BADGE, band: 2 }],
    }),
  );
  assert.ok(
    !validateCertSubjectIndex({ format: "woco.cert-index.v1", subjects: [BADGE] }),
    "the V1 SHAPE must not pass under this type's v1 NAME",
  );
  assert.ok(
    !validateCertSubjectIndex({ format: "woco.pod-cert-index.v1", entries: [{ subject: BADGE, band: 2 }] }),
    "the v1 rail's index is a different format id",
  );
});
