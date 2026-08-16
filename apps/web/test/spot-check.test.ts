/**
 * Going and reading one of the entries the working points at.
 *
 * Recounting proves a total is the total its evidence supports. It proves
 * nothing about whether the entries exist — a counter that invented a rider and
 * a number publishes a list that recounts perfectly. So the properties here are
 * about what happens when the page goes and looks:
 *
 *   - The address is derived from the leaf and the PUBLIC rules alone, so the
 *     bytes come from storage rather than from the counter making the claim.
 *   - `version` is the feed's, not the rider's `seq`. Two leaves differing only
 *     in `seq` must derive the SAME address, and two differing only in
 *     `version` must derive different ones — that is the whole reason the field
 *     was added.
 *   - Silence is never an accusation. A timeout, a 403 behind a whitelist lag,
 *     a 404 on a record still settling: all "not checked", never "wrong". A
 *     false accusation aimed at a real rider's logbook is worse than no check.
 *   - Disagreement IS an accusation, and has to be reached for the right
 *     reasons: a bad signature, a different rider, a different number.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  RITA_SUBJECT,
  signCreditStatement,
  creditStatementDigest,
  SOC_IDENTIFIER_SIZE,
  SOC_SIGNATURE_SIZE,
  LEGACY_CONTENT_FEED_VERSION,
  CONTENT_FEED_MC_MARKER,
  type CarriedEvidenceLeaf,
  type CreditStatementV1,
  type UnsignedCreditStatementV1,
  type Hex0x,
} from "@woco/shared";
import { deriveEntryLocation, leafToCheck, spotCheckLeaf } from "../src/lib/credits/spot-check.js";

const OWNER = `0x${"11".repeat(20)}` as Hex0x;
const OWNER_2 = `0x${"22".repeat(20)}` as Hex0x;
const GATEWAY = "https://gateway.example.test";

/**
 * ed25519 public key for a seed, via node:crypto: this workspace resolves
 * `@noble/curves` to a copy whose exports map has no `./ed25519.js`, while
 * `@woco/shared` resolves its own. Signing therefore stays inside shared.
 */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
function publicKeyHex(seed: Uint8Array): string {
  const priv = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" });
  return spki.subarray(spki.length - 32).toString("hex");
}

const RIDER_KEY = new Uint8Array(32).fill(7);
const RIDER = publicKeyHex(RIDER_KEY);
const IMPOSTOR_KEY = new Uint8Array(32).fill(9);

function statement(over: Partial<UnsignedCreditStatementV1> = {}, key = RIDER_KEY): CreditStatementV1 {
  return signCreditStatement(
    {
      format: "woco.credit.v1",
      subject: RITA_SUBJECT,
      holder: publicKeyHex(key),
      seq: 4,
      total: 109,
      session: { date: "2026-09-01", count: 3 },
      ...over,
    } as UnsignedCreditStatementV1,
    key,
  );
}

/** The leaf a counter would publish for a statement it read at `version`. */
function leafFor(s: CreditStatementV1, version = 2, feedOwner: Hex0x = OWNER): CarriedEvidenceLeaf {
  const { holderSig: _sig, ...unsigned } = s;
  return {
    holder: s.holder,
    feedOwner,
    seq: s.seq,
    version,
    digest: `0x${bytesToHex(creditStatementDigest(unsigned))}` as Hex0x,
    total: s.total,
  };
}

/** A stored chunk: identifier ‖ signature ‖ span ‖ payload. */
function storedChunk(identifier: Uint8Array, payload: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const out = new Uint8Array(SOC_IDENTIFIER_SIZE + SOC_SIGNATURE_SIZE + 8 + body.length);
  out.set(identifier, 0);
  out.set(body, SOC_IDENTIFIER_SIZE + SOC_SIGNATURE_SIZE + 8);
  return out;
}

/** A fetch that serves one address, recording what was asked for. */
function gatewayServing(bytes: Uint8Array | number): { impl: typeof fetch; asked: string[] } {
  const asked: string[] = [];
  const impl = (async (url: string | URL) => {
    asked.push(String(url));
    if (typeof bytes === "number") return new Response(null, { status: bytes });
    return new Response(bytes as unknown as BodyInit, { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, asked };
}

const check = (leaf: CarriedEvidenceLeaf, served: Uint8Array | number) =>
  spotCheckLeaf(RITA_SUBJECT, leaf, { gateway: GATEWAY, fetchImpl: gatewayServing(served).impl });

// ── Deriving where to look ───────────────────────────────────────────────────

test("the address derives from the leaf alone, and the counter is never asked", async () => {
  const s = statement();
  const leaf = leafFor(s);
  const { identifier, address } = deriveEntryLocation(RITA_SUBJECT, leaf);
  const gw = gatewayServing(storedChunk(identifier, s));

  const result = await spotCheckLeaf(RITA_SUBJECT, leaf, { gateway: GATEWAY, fetchImpl: gw.impl });
  assert.equal(result.state, "confirmed");
  assert.deepEqual(gw.asked, [`${GATEWAY}/chunks/${address}`], "storage, not the counter");
});

test("the FEED version moves the address; the rider's seq does not", () => {
  // The distinction the leaf field exists for. Deriving from `seq` would look
  // right and address the wrong chunk on any logbook that has migrated.
  const base = leafFor(statement(), 2);
  const otherSeq = { ...base, seq: base.seq + 50 };
  const otherVersion = { ...base, version: 3 };

  assert.equal(deriveEntryLocation(RITA_SUBJECT, otherSeq).address, deriveEntryLocation(RITA_SUBJECT, base).address);
  assert.notEqual(
    deriveEntryLocation(RITA_SUBJECT, otherVersion).address,
    deriveEntryLocation(RITA_SUBJECT, base).address,
  );
});

test("a logbook written before versioning is still addressable", () => {
  const legacy = leafFor(statement(), LEGACY_CONTENT_FEED_VERSION);
  assert.match(deriveEntryLocation(RITA_SUBJECT, legacy).address, /^[0-9a-f]{64}$/);
  assert.notEqual(
    deriveEntryLocation(RITA_SUBJECT, legacy).address,
    deriveEntryLocation(RITA_SUBJECT, leafFor(statement(), 0)).address,
  );
});

test("two riders' logbooks are different places", () => {
  const s = statement();
  assert.notEqual(
    deriveEntryLocation(RITA_SUBJECT, leafFor(s, 2, OWNER)).address,
    deriveEntryLocation(RITA_SUBJECT, leafFor(s, 2, OWNER_2)).address,
  );
});

// ── Confirming ───────────────────────────────────────────────────────────────

test("an entry that is there, signed, and carries the counted number is confirmed", async () => {
  const s = statement();
  const leaf = leafFor(s);
  const { identifier } = deriveEntryLocation(RITA_SUBJECT, leaf);

  const result = await check(leaf, storedChunk(identifier, s));
  assert.equal(result.state, "confirmed");
  assert.equal(result.state === "confirmed" && result.total, 109);
});

test("padding on the stored bytes does not defeat the check", async () => {
  const s = statement();
  const leaf = leafFor(s);
  const { identifier } = deriveEntryLocation(RITA_SUBJECT, leaf);
  const padded = new Uint8Array(storedChunk(identifier, s).length + 16);
  padded.set(storedChunk(identifier, s));

  assert.equal((await check(leaf, padded)).state, "confirmed");
});

// ── Accusing, for the right reasons ──────────────────────────────────────────

test("an entry the named rider did not sign is contradicted", async () => {
  // The forgery the rider's signature exists to stop: a real statement, signed
  // by someone else, relabelled with the rider's key.
  const forged = { ...statement({}, IMPOSTOR_KEY), holder: RIDER };
  const leaf = leafFor(statement());
  const { identifier } = deriveEntryLocation(RITA_SUBJECT, leaf);

  const result = await check(leaf, storedChunk(identifier, forged));
  assert.equal(result.state, "contradicted");
  assert.match(result.state === "contradicted" ? result.because : "", /not signed by the rider/);
});

test("an entry carrying a different number from the one counted is contradicted", async () => {
  const leaf = leafFor(statement({ total: 109 }));
  const { identifier } = deriveEntryLocation(RITA_SUBJECT, leaf);

  const result = await check(leaf, storedChunk(identifier, statement({ total: 3 })));
  assert.equal(result.state, "contradicted");
  assert.match(result.state === "contradicted" ? result.because : "", /different number/);
});

test("an entry for another coaster is contradicted", async () => {
  const leaf = leafFor(statement());
  const { identifier } = deriveEntryLocation(RITA_SUBJECT, leaf);
  const elsewhere = statement({ subject: `0x${"cc".repeat(32)}` as Hex0x });

  const result = await check(leaf, storedChunk(identifier, elsewhere));
  assert.equal(result.state, "contradicted");
  assert.match(result.state === "contradicted" ? result.because : "", /different rider or coaster/);
});

test("bytes filed under a different entry are contradicted", async () => {
  // The address was derived from the identifier, so a chunk carrying another
  // one was not produced by the rules the address came from.
  const s = statement();
  const leaf = leafFor(s);

  const result = await check(leaf, storedChunk(new Uint8Array(SOC_IDENTIFIER_SIZE).fill(9), s));
  assert.equal(result.state, "contradicted");
  assert.match(result.state === "contradicted" ? result.because : "", /different entry/);
});

// ── Never accusing on silence ────────────────────────────────────────────────

test("nothing at that address is reported as missing, not as wrong", async () => {
  // A record that has not settled on the network yet looks exactly like this.
  const result = await check(leafFor(statement()), 404);
  assert.equal(result.state, "missing");
});

test("a gateway that refuses or fails leaves the entry unchecked", async () => {
  for (const status of [403, 500, 502]) {
    const result = await check(leafFor(statement()), status);
    assert.equal(result.state, "unchecked", `HTTP ${status} must not accuse`);
  }
});

test("a gateway that cannot be reached at all leaves the entry unchecked", async () => {
  const impl = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const result = await spotCheckLeaf(RITA_SUBJECT, leafFor(statement()), { gateway: GATEWAY, fetchImpl: impl });
  assert.equal(result.state, "unchecked");
});

test("bytes that are not a readable entry leave it unchecked rather than accused", async () => {
  const leaf = leafFor(statement());
  const { identifier } = deriveEntryLocation(RITA_SUBJECT, leaf);
  const notJson = new Uint8Array(SOC_IDENTIFIER_SIZE + SOC_SIGNATURE_SIZE + 8 + 4);
  notJson.set(identifier, 0);
  notJson.set(new TextEncoder().encode("<htm"), SOC_IDENTIFIER_SIZE + SOC_SIGNATURE_SIZE + 8);

  assert.equal((await check(leaf, notJson)).state, "unchecked");
  assert.equal((await check(leaf, new Uint8Array(4))).state, "unchecked", "and a runt chunk too");
});

test("an entry stored in parts says so instead of pretending the check ran", async () => {
  const leaf = leafFor(statement());
  const { identifier } = deriveEntryLocation(RITA_SUBJECT, leaf);
  // Built from the exported marker, not a guess at it: a fixture with the wrong
  // marker would let this pass while a real paged entry was ACCUSED.
  const manifest = { [CONTENT_FEED_MC_MARKER]: 1, pages: 2, len: 8000 };

  const result = await check(leaf, storedChunk(identifier, manifest));
  assert.equal(result.state, "unchecked");
  assert.match(result.state === "unchecked" ? result.because : "", /stored in parts/);
});

// ── Which entry gets checked ─────────────────────────────────────────────────

test("a named rider's entry is the one checked", () => {
  const mine = leafFor(statement({ total: 5 }));
  const theirs = leafFor(statement({ total: 900 }), 2, OWNER_2);
  assert.equal(leafToCheck([mine, theirs], mine), mine);
});

test("with nobody named, the largest entry is checked — the one a sceptic would pick", () => {
  const small = leafFor(statement({ total: 3 }));
  const large = leafFor(statement({ total: 109 }), 2, OWNER_2);
  assert.equal(leafToCheck([small, large], null), large);
});

test("an entry with no laps is never the one checked, and no entries means no check", () => {
  const empty = leafFor(statement({ total: 0 }));
  assert.equal(leafToCheck([empty], null), null);
  assert.equal(leafToCheck([], null), null);
});
