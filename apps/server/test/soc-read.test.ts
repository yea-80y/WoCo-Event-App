/**
 * The verified, source-listed SOC read (#156): the aggregate rule and the
 * verification, the latter against a SOC bee-js itself signed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Bee, Bytes, Identifier, PrivateKey, Reference, Span } from "@ethersphere/bee-js";
import { calculateCacAddress, encodeSpan } from "@woco/shared";
import {
  aggregateSocReads,
  readVerifiedSoc,
  verifyStoredSoc,
  type SocSource,
  type RawSocRead,
} from "../src/lib/swarm/soc-read.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** A real SOC, as stored: identifier ‖ signature ‖ span ‖ payload. */
function makeStoredSoc(payloadText = '{"hello":"world"}') {
  const signer = new PrivateKey("0x" + "11".repeat(32));
  const payload = new TextEncoder().encode(payloadText);
  const span = encodeSpan(payload.length);
  const identifier = new Uint8Array(32).fill(7);
  const soc = new Bee("http://localhost:1633").makeSingleOwnerChunk(
    new Reference(calculateCacAddress(span, payload)),
    Span.fromBigInt(BigInt(payload.length)),
    new Bytes(payload),
    new Identifier(identifier),
    signer,
  );
  const owner = soc.owner.toHex().replace(/^0x/, "").toLowerCase();
  const raw = new Uint8Array(32 + 65 + 8 + payload.length);
  raw.set(identifier, 0);
  raw.set(soc.signature.toUint8Array(), 32);
  raw.set(span, 97);
  raw.set(payload, 105);
  return { raw, owner, identifier: hex(identifier), payload };
}

const src = (name: string, negativeAuthority: "verdict" | "hint", read: RawSocRead): SocSource => ({
  name,
  negativeAuthority,
  read: async () => read,
});

test("verify: a bee-signed SOC passes; a flipped byte, a wrong identifier or a wrong owner fail", () => {
  const { raw, owner, identifier } = makeStoredSoc();
  assert.equal(verifyStoredSoc(raw, owner, identifier).ok, true);
  const tampered = raw.slice();
  tampered[tampered.length - 1] ^= 0x01;
  assert.equal(verifyStoredSoc(tampered, owner, identifier).ok, false);
  assert.equal(verifyStoredSoc(raw, owner, "ff".repeat(32)).ok, false);
  assert.equal(verifyStoredSoc(raw, "ab".repeat(20), identifier).ok, false);
  assert.equal(verifyStoredSoc(raw.subarray(0, 50), owner, identifier).ok, false);
});

test("aggregate: any found wins; an unreachable source makes it unavailable, never absent", () => {
  const found: RawSocRead = { status: "found", raw: new Uint8Array([1]) };
  const bee = src("bee", "verdict", { status: "absent" });
  assert.equal(aggregateSocReads([{ source: bee, read: { status: "absent" } }]).status, "absent");
  assert.equal(
    aggregateSocReads([
      { source: bee, read: { status: "absent" } },
      { source: src("etherna", "verdict", found), read: found },
    ]).status,
    "found",
  );
  const r = aggregateSocReads([
    { source: bee, read: { status: "absent" } },
    { source: src("etherna", "verdict", { status: "unavailable", reason: "timeout" }), read: { status: "unavailable", reason: "timeout" } },
  ]);
  assert.equal(r.status, "unavailable");
  if (r.status === "unavailable") assert.match(r.reason, /etherna: timeout/);
  // bee itself faulting (500) is unavailable, not absent
  assert.equal(
    aggregateSocReads([{ source: bee, read: { status: "unavailable", reason: "bee HTTP 500" } }]).status,
    "unavailable",
  );
});

test("aggregate: a hint source's miss is not a verdict; with no verdict source the answer is unavailable", () => {
  const hint = src("browserNode", "hint", { status: "absent" });
  assert.equal(aggregateSocReads([{ source: hint, read: { status: "absent" } }]).status, "unavailable");
  // hint absent + verdict absent → absent (the hint miss neither helps nor blocks)
  assert.equal(
    aggregateSocReads([
      { source: hint, read: { status: "absent" } },
      { source: src("bee", "verdict", { status: "absent" }), read: { status: "absent" } },
    ]).status,
    "absent",
  );
});

test("readVerifiedSoc: a source that serves bytes which are not this chunk counts as unreachable, and the next source is asked", async () => {
  const good = makeStoredSoc();
  const bad = makeStoredSoc('{"other":1}'); // same owner + identifier, different payload → its signature is for different bytes
  // forge: good identifier/owner but bad payload + bad's signature → fails verification
  const forged = bad.raw;
  const calls: string[] = [];
  const res = await readVerifiedSoc(good.owner, good.identifier, {
    sources: [
      { name: "hostile", negativeAuthority: "verdict", read: async () => { calls.push("hostile"); return { status: "found", raw: forged.slice(0, 40) }; } },
      { name: "honest", negativeAuthority: "verdict", read: async () => { calls.push("honest"); return { status: "found", raw: good.raw }; } },
    ],
  });
  assert.deepEqual(calls, ["hostile", "honest"]);
  assert.equal(res.status, "found");
  if (res.status === "found") {
    assert.equal(res.soc.source, "honest");
    assert.equal(res.soc.owner, good.owner);
    assert.equal(res.soc.identifier, good.identifier);
    assert.equal(Buffer.from(res.soc.payload).toString(), Buffer.from(good.payload).toString());
  }
  // hostile alone: unverifiable bytes + nobody else → unavailable, NOT absent
  const alone = await readVerifiedSoc(good.owner, good.identifier, {
    sources: [{ name: "hostile", negativeAuthority: "verdict", read: async () => ({ status: "found", raw: forged.slice(0, 40) }) }],
  });
  assert.equal(alone.status, "unavailable");
});

test("readVerifiedSoc: malformed owner/identifier is a 400, not a search", async () => {
  await assert.rejects(() => readVerifiedSoc("zz", "00".repeat(32), { sources: [] }), (e: Error & { status?: number }) => e.status === 400);
  await assert.rejects(() => readVerifiedSoc("ab".repeat(20), "00", { sources: [] }), (e: Error & { status?: number }) => e.status === 400);
});
