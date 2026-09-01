/**
 * The issuer registry — statement + log verification (PR 5b).
 *
 * Every signature here is REAL: the parent's EIP-712 signature is produced by
 * signing the module's own `issuerStatementDigest` with a raw secp key (the
 * digest is byte-identical to what ethers produces — the server suite pins
 * that interop with an actual ethers Wallet), the PoP and rotation
 * co-signatures come from genuinely derived issuing keys. No mocks: a
 * regression in any recover/compare path fails a signature check, not a stub.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { deriveIssuingKey, signPersonalMessage, buildIssuerBindingMessage } from "../../src/crypto/issuing.js";
import {
  ISSUER_LOG_FORMAT,
  ISSUER_STATEMENT_FORMAT,
  ZERO_ADDRESS,
  buildIssuerRotationMessage,
  issuerRegistryTopicName,
  issuerStatementDigest,
  validateIssuerStatementV1,
  verifyIssuerLog,
  verifyIssuerStatement,
  type IssuerStatementV1,
} from "../../src/issuer/types.js";

// --- a real parent wallet key, signed with noble (ethers-compatible bytes) ---
const PARENT_PRIV = new Uint8Array(32).fill(3);
const PARENT = ("0x" +
  bytesToHex(keccak_256(secp256k1.getPublicKey(PARENT_PRIV, false).subarray(1)).subarray(12))) as `0x${string}`;
const OTHER_PARENT_PRIV = new Uint8Array(32).fill(5);

function signDigest(digest: Uint8Array, priv: Uint8Array): `0x${string}` {
  const sig = secp256k1.sign(digest, priv, { prehash: false, format: "recovered" });
  const v = (sig[0]! + 27).toString(16).padStart(2, "0");
  return ("0x" + bytesToHex(sig.subarray(1)) + v) as `0x${string}`;
}

const GEN0 = deriveIssuingKey("0x" + "ab".repeat(32), 0);
const GEN1 = deriveIssuingKey("0x" + "ab".repeat(32), 1);
const STRANGER = deriveIssuingKey("0x" + "cd".repeat(32), 0);

function statement(gen: number, over: Partial<IssuerStatementV1> = {}): IssuerStatementV1 {
  const key = gen === 0 ? GEN0 : GEN1;
  const base = {
    format: ISSUER_STATEMENT_FORMAT,
    parent: PARENT,
    issuer: key.address,
    gen,
    certLogOwner: ZERO_ADDRESS as `0x${string}`,
    reason: gen === 0 ? "seed" : "rotation",
    issuedAt: "2026-09-01T12:00:00Z",
    ...over,
  };
  const unsigned = {
    parent: base.parent, issuer: base.issuer, gen: base.gen,
    certLogOwner: base.certLogOwner, reason: base.reason, issuedAt: base.issuedAt,
  };
  return {
    ...base,
    parentSig: over.parentSig ?? signDigest(issuerStatementDigest(unsigned), PARENT_PRIV),
    bindingSig:
      over.bindingSig ??
      signPersonalMessage(buildIssuerBindingMessage(base.parent, base.gen), key.privateKey),
    ...(over.prevSig !== undefined ? { prevSig: over.prevSig } : {}),
  } as IssuerStatementV1;
}

// ---------------------------------------------------------------------------
// Statement level
// ---------------------------------------------------------------------------

test("a valid gen-0 statement verifies", () => {
  const v = verifyIssuerStatement(statement(0));
  assert.equal(v.ok, true, (v as { error?: string }).error);
});

test("a parentSig by a DIFFERENT wallet is refused — the binding authority is the parent", () => {
  const s = statement(0);
  const forged = { ...s, parentSig: signDigest(issuerStatementDigest(s), OTHER_PARENT_PRIV) };
  const v = verifyIssuerStatement(forged);
  assert.equal(v.ok, false);
  assert.match((v as { error: string }).error, /not made by the statement's parent/);
});

test("tampering ANY signed field after signing is refused", () => {
  for (const over of [
    { reason: "edited" },
    { issuedAt: "2027-01-01T00:00:00Z" },
    { certLogOwner: ("0x" + "44".repeat(20)) as `0x${string}` },
    { issuer: STRANGER.address },
  ]) {
    const good = statement(0);
    const tampered = { ...good, ...over };
    const v = verifyIssuerStatement(tampered);
    assert.equal(v.ok, false, `accepted tamper: ${JSON.stringify(over)}`);
  }
});

test("a bindingSig from a key that is not the stated issuer fails possession", () => {
  const v = verifyIssuerStatement(
    statement(0, {
      bindingSig: signPersonalMessage(buildIssuerBindingMessage(PARENT, 0), STRANGER.privateKey),
    }),
  );
  assert.equal(v.ok, false);
  assert.match((v as { error: string }).error, /does not prove possession/);
});

test("a malleated high-s parentSig is refused — nothing keys off signature bytes", () => {
  const s = statement(0);
  const raw = hexToBytes(s.parentSig.slice(2));
  const N = secp256k1.Point.Fn.ORDER;
  const sVal = BigInt("0x" + bytesToHex(raw.subarray(32, 64)));
  const malleated = ("0x" +
    bytesToHex(raw.subarray(0, 32)) +
    (N - sVal).toString(16).padStart(64, "0") +
    (raw[64] === 27 ? "1c" : "1b")) as `0x${string}`;
  const v = verifyIssuerStatement({ ...s, parentSig: malleated });
  assert.equal(v.ok, false);
});

test("the closed schema refuses non-canonical and extra input", () => {
  const good = statement(0);
  assert.ok(validateIssuerStatementV1(good));
  assert.ok(!validateIssuerStatementV1({ ...good, extra: 1 }), "unknown key accepted");
  assert.ok(!validateIssuerStatementV1({ ...good, parent: good.parent.toUpperCase() }), "uppercase parent");
  assert.ok(!validateIssuerStatementV1({ ...good, issuer: good.issuer.slice(2) }), "0x-less issuer");
  assert.ok(!validateIssuerStatementV1({ ...good, gen: 1.5 }));
  assert.ok(!validateIssuerStatementV1({ ...good, gen: 10_000_000 }), "absurd generation");
  assert.ok(!validateIssuerStatementV1({ ...good, issuedAt: "yesterday" }));
  assert.ok(!validateIssuerStatementV1({ ...good, reason: "x".repeat(201) }), "unbounded reason");
  const { certLogOwner: _c, ...missing } = good;
  assert.ok(!validateIssuerStatementV1(missing), "certLogOwner is required (zero address = none)");
});

// ---------------------------------------------------------------------------
// Log level
// ---------------------------------------------------------------------------

function log(statements: IssuerStatementV1[]) {
  return { format: ISSUER_LOG_FORMAT, parent: PARENT, statements };
}

function rotationSig(): `0x${string}` {
  return signPersonalMessage(
    buildIssuerRotationMessage(PARENT, 0, 1, GEN1.address),
    GEN0.privateKey,
  );
}

test("a co-signed rotation chain verifies; current is the latest generation", () => {
  const v = verifyIssuerLog(log([statement(0), statement(1, { prevSig: rotationSig() })]));
  assert.equal(v.ok, true, (v as { error?: string }).error);
  if (v.ok) {
    assert.equal(v.current.gen, 1);
    assert.equal(v.current.issuer, GEN1.address);
    assert.deepEqual(v.unattestedRotations, []);
  }
});

test("a rotation WITHOUT the co-signature verifies but is FLAGGED — break-glass is visible, not blocked", () => {
  const v = verifyIssuerLog(log([statement(0), statement(1)]));
  assert.equal(v.ok, true);
  if (v.ok) assert.deepEqual(v.unattestedRotations, [1]);
});

test("a co-signature by the WRONG previous key is refused, not flagged", () => {
  const bad = signPersonalMessage(
    buildIssuerRotationMessage(PARENT, 0, 1, GEN1.address),
    STRANGER.privateKey,
  );
  const v = verifyIssuerLog(log([statement(0), statement(1, { prevSig: bad })]));
  assert.equal(v.ok, false);
  assert.match((v as { error: string }).error, /not the previous issuer's co-signature/);
});

test("generation gaps, foreign parents, empty logs and a co-signed first entry are refused", () => {
  const gen2 = deriveIssuingKey("0x" + "ab".repeat(32), 2);
  const skipped = statement(1, {
    gen: 2, issuer: gen2.address,
    bindingSig: signPersonalMessage(buildIssuerBindingMessage(PARENT, 2), gen2.privateKey),
    parentSig: signDigest(
      issuerStatementDigest({ parent: PARENT, issuer: gen2.address, gen: 2, certLogOwner: ZERO_ADDRESS as `0x${string}`, reason: "rotation", issuedAt: "2026-09-01T12:00:00Z" }),
      PARENT_PRIV,
    ),
  });
  assert.equal(verifyIssuerLog(log([statement(0), skipped])).ok, false, "gen skip accepted");
  assert.equal(verifyIssuerLog({ ...log([statement(0)]), parent: "0x" + "99".repeat(20) }).ok, false);
  assert.equal(verifyIssuerLog(log([])).ok, false, "an empty log carries no binding");
  assert.equal(verifyIssuerLog(log([statement(0, { prevSig: rotationSig() })])).ok, false, "first entry co-signed");
});

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

test("the rotation message binds parent, both generations and the successor — and refuses bad steps", () => {
  const msg = buildIssuerRotationMessage(PARENT, 0, 1, GEN1.address);
  assert.equal(msg, `woco-issuer-rotation-v1\n${PARENT}\n0\n1\n${GEN1.address}`);
  assert.throws(() => buildIssuerRotationMessage(PARENT, 0, 2, GEN1.address), /step by exactly 1/);
  assert.throws(() => buildIssuerRotationMessage(PARENT.toUpperCase(), 0, 1, GEN1.address), /parent/);
  assert.throws(() => buildIssuerRotationMessage(PARENT, 0, 1, GEN1.address.toUpperCase()), /newIssuer/);
});

test("the registry topic is lowercase and parent-scoped", () => {
  assert.equal(issuerRegistryTopicName(PARENT.toUpperCase()), `woco/issuer/${PARENT}`);
});
