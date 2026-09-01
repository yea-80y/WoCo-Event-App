/**
 * Cross-protocol personal-sign matrix (issuer-curve migration PR 3).
 *
 * Several WoCo secp256k1 keys EIP-191-personal-sign more than one kind of
 * message, and bee-js personal-signs every SOC digest as exactly 32 raw bytes
 * (measured in PR 1: envelope `\x19Ethereum Signed Message:\n32` over
 * keccak256(identifier ‖ cacAddress)). A WoCo canonical message that could be
 * 32 bytes, or two domains that could produce the same bytes, would make one
 * protocol's signature replayable in another. The matrix rule:
 *
 *   - every WoCo canonical personal-sign message begins with a domain line
 *     unique to its format, and
 *   - NO builder can emit a 32-byte message, so the SOC domain (raw 32 bytes)
 *     is disjoint from all of them by length alone.
 *
 * Domains covered: SOC (\n32) · woco-ticket-v1 (burner) · woco-manifest-v2
 * (issuing key) · woco-cert-v1 (issuing key). `woco-claimed-owner-v2` left the
 * codebase with #448 (produced by nothing, verified by nothing) and so left
 * the matrix with it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { deriveIssuingKey } from "../../src/crypto/issuing.js";
import { buildManifestV2Message, manifestV2Digest } from "../../src/edition/canonical.js";
import { signManifestV2, verifyManifestV2 } from "../../src/edition/merkle.js";
import type { ManifestV2Body } from "../../src/edition/types.js";
import { buildTicketCanonicalMessage } from "../../src/ticket/canonical.js";
import { STATEMENT_SIGNING_PREFIXES } from "../../src/statement/discipline.js";

const { privateKey: ISSUING_PRIV, address: ISSUER } = deriveIssuingKey("0x" + "ab".repeat(32), 0);

const body: ManifestV2Body = {
  format: "woco.manifest.v2",
  totalSupply: 2,
  issuer: ISSUER,
  metadataRoot: ("0x" + "33".repeat(32)) as ManifestV2Body["metadataRoot"],
  encoding: "cbor-v1",
  treeScheme: "oz-simple-v1",
};

/** bee-js's SOC signing, reproduced: EIP-191 over the raw 32-byte digest.
 *  Deliberately test-local — shared src must never grow an API that
 *  personal-signs caller-supplied raw digest bytes. */
function socStyleSign(digest32: Uint8Array, privateKey: Uint8Array): `0x${string}` {
  assert.equal(digest32.length, 32);
  const envelope = keccak_256(
    concatBytes(utf8ToBytes("\x19Ethereum Signed Message:\n32"), digest32),
  );
  const sig = secp256k1.sign(envelope, privateKey, { prehash: false, format: "recovered" });
  const v = (sig[0]! + 27).toString(16).padStart(2, "0");
  return ("0x" + bytesToHex(sig.subarray(1)) + v) as `0x${string}`;
}

test("no WoCo canonical builder can emit a 32-byte message", () => {
  const manifestMsg = buildManifestV2Message(new Uint8Array(32));
  assert.equal(utf8ToBytes(manifestMsg).length, 83);

  const certMsg = `${STATEMENT_SIGNING_PREFIXES["woco.cert.v1"]}0x${"00".repeat(32)}`;
  assert.equal(utf8ToBytes(certMsg).length, 79);

  const minimalTicket = buildTicketCanonicalMessage({
    onChainEventId: "0x" + "00".repeat(32),
    seriesId: "a",
    edition: 1,
  });
  assert.equal(utf8ToBytes(minimalTicket).length, 86, "the shortest possible ticket message");
  // All fields only grow the message, so 86 is the floor: every domain clears
  // 32 bytes and the SOC domain is disjoint by length alone.
  for (const len of [83, 79, 86]) assert.notEqual(len, 32);
});

test("every domain line is distinct", () => {
  const domains = [
    buildManifestV2Message(new Uint8Array(32)).split("\n")[0],
    STATEMENT_SIGNING_PREFIXES["woco.cert.v1"].split("\n")[0],
    STATEMENT_SIGNING_PREFIXES["woco.cert-challenge.v1"].split("\n")[0],
    buildTicketCanonicalMessage({
      onChainEventId: "0x" + "00".repeat(32),
      seriesId: "a",
      edition: 1,
    }).split("\n")[0],
  ];
  assert.equal(new Set(domains).size, domains.length, `domain collision in: ${domains}`);
});

test("a SOC-style signature over the manifest digest does NOT verify as a manifest signature", () => {
  const signed = signManifestV2(body, ISSUING_PRIV);
  assert.ok(verifyManifestV2(signed));
  // The adversary's best case: the SAME key personal-signs the SAME 32 bytes,
  // but as a raw SOC digest (\n32 envelope) instead of the domain message.
  const socSig = socStyleSign(manifestV2Digest(body), ISSUING_PRIV);
  assert.notEqual(socSig, signed.signature);
  assert.ok(
    !verifyManifestV2({ ...signed, signature: socSig }),
    "a raw-digest (SOC-domain) signature verified as a manifest signature — cross-protocol forgeable",
  );
});

test("a manifest signature does not verify as a SOC signature over the digest", () => {
  const signed = signManifestV2(body, ISSUING_PRIV);
  const digest = manifestV2Digest(body);
  const socEnvelope = keccak_256(
    concatBytes(utf8ToBytes("\x19Ethereum Signed Message:\n32"), digest),
  );
  const raw = Uint8Array.from(Buffer.from(signed.signature.slice(2), "hex"));
  const recovered = new Uint8Array(65);
  recovered[0] = raw[64]! - 27;
  recovered.set(raw.subarray(0, 64), 1);
  const sig = secp256k1.Signature.fromBytes(recovered, "recovered");
  const pub = sig.recoverPublicKey(socEnvelope).toBytes(false);
  const addr = "0x" + bytesToHex(keccak_256(pub.subarray(1)).subarray(12));
  assert.notEqual(addr, ISSUER, "manifest signature recovered to the issuer under the SOC envelope");
});
