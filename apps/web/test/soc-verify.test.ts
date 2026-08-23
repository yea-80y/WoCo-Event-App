/**
 * Client-side verification of a server-served SOC (#156), against a SOC bee-js signed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Bee, Bytes, Identifier, PrivateKey, Reference, Span } from "@ethersphere/bee-js";
import { calculateCacAddress, encodeSpan } from "@woco/shared";
import { verifyServedSoc } from "../src/lib/swarm/soc-verify.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function served(payloadText = '{"v":1}', idByte = 9) {
  const signer = new PrivateKey("0x" + "22".repeat(32));
  const payload = new TextEncoder().encode(payloadText);
  const span = encodeSpan(payload.length);
  const identifier = new Uint8Array(32).fill(idByte);
  const soc = new Bee("http://localhost:1633").makeSingleOwnerChunk(
    new Reference(calculateCacAddress(span, payload)),
    Span.fromBigInt(BigInt(payload.length)),
    new Bytes(payload),
    new Identifier(identifier),
    signer,
  );
  return {
    wire: {
      owner: soc.owner.toHex(),
      identifier: hex(identifier),
      signature: soc.signature.toHex(),
      span: hex(span),
      payload,
    },
    identifier,
    owner: soc.owner.toHex().replace(/^0x/, "").toLowerCase(),
  };
}

test("a genuine SOC verifies (owner with or without 0x, any case)", () => {
  const s = served();
  assert.deepEqual(verifyServedSoc(s.wire, { owner: s.owner, identifier: s.identifier }), { ok: true });
  assert.deepEqual(verifyServedSoc({ ...s.wire, owner: s.wire.owner.toUpperCase() }, { owner: "0x" + s.owner, identifier: s.identifier }), { ok: true });
});

test("tampered payload, wrong span, wrong identifier, wrong owner, bad signature all fail", () => {
  const s = served();
  const tampered = s.wire.payload.slice(); tampered[0] ^= 1;
  assert.equal(verifyServedSoc({ ...s.wire, payload: tampered }, { owner: s.owner, identifier: s.identifier }).ok, false);
  assert.equal(verifyServedSoc({ ...s.wire, span: "00".repeat(8) }, { owner: s.owner, identifier: s.identifier }).ok, false);
  assert.equal(verifyServedSoc(s.wire, { owner: s.owner, identifier: new Uint8Array(32).fill(1) }).ok, false);
  assert.equal(verifyServedSoc(s.wire, { owner: "ab".repeat(20), identifier: s.identifier }).ok, false);
  assert.equal(verifyServedSoc({ ...s.wire, signature: "00".repeat(65) }, { owner: s.owner, identifier: s.identifier }).ok, false);
  assert.equal(verifyServedSoc({ ...s.wire, signature: "zz" }, { owner: s.owner, identifier: s.identifier }).ok, false);
});

test("rollback: an older genuine chunk served for a newer identifier does not verify", () => {
  const old = served('{"v":1}', 1);
  const newer = served('{"v":2}', 2);
  // Server hands back the OLD chunk's fields while we asked for the NEW identifier.
  assert.equal(verifyServedSoc(old.wire, { owner: newer.owner, identifier: newer.identifier }).ok, false);
  // …and even if it relabels the identifier, the signature was over the old one.
  assert.equal(verifyServedSoc({ ...old.wire, identifier: newer.wire.identifier }, { owner: newer.owner, identifier: newer.identifier }).ok, false);
});
