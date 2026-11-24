/**
 * The signed void list (`src/holding/void-list.ts`): golden tag, padded entries, hash,
 * digest and signature against ethers; the size bands; and every way a verifier
 * refuses to trust a list.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AbiCoder, TypedDataEncoder, Wallet, concat, keccak256, toUtf8Bytes } from "ethers";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  VOID_LIST_FIELDS,
  checkVoidList,
  isValidVoidEntries,
  padVoidEntries,
  signVoidList,
  voidEntriesHash,
  voidListDigest,
  voidListSize,
  voidListStatement,
  voidTag,
} from "../../src/holding/void-list.js";
import { EVENT_ID, G, T0, TARGET, VOID_SIGNER_KEY, counterRandom } from "./vectors.js";

const HEADER = { eventId: EVENT_ID, entriesHash: G.entriesHash, seq: 3, issuedAt: T0, validUntil: T0 + 21_600 };
const SIGNER = new Wallet(`0x${bytesToHex(VOID_SIGNER_KEY)}`).address.toLowerCase();

test("type string and golden values, equal to ethers", async () => {
  assert.equal(
    `VoidList(${VOID_LIST_FIELDS.map((f) => `${f.type} ${f.name}`).join(",")})`,
    "VoidList(bytes32 eventId,bytes32 entriesHash,uint64 seq,uint64 issuedAt,uint64 validUntil)",
  );
  assert.equal(voidTag(G.receiptDigest), G.voidTag);
  const label = keccak256(toUtf8Bytes("woco/holding/v1/void-tag"));
  assert.equal(keccak256(AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32"], [label, G.receiptDigest])), G.voidTag);
  assert.deepEqual(padVoidEntries([G.voidTag], await counterRandom()), G.entries);
  assert.equal(voidEntriesHash(G.entries), G.entriesHash);
  assert.equal(keccak256(concat(G.entries)), G.entriesHash);
  const s = voidListStatement(TARGET, HEADER);
  assert.equal(TypedDataEncoder.hash(s.domain, { VoidList: [...s.fields] }, s.message), G.voidListDigest);
  assert.equal(voidListDigest(TARGET, HEADER), G.voidListDigest);
  assert.equal(signVoidList(TARGET, HEADER, VOID_SIGNER_KEY), G.voidListSig);
});

test("size bands: the smallest of 8, 16, 32 ... that fits", () => {
  assert.deepEqual([0, 1, 8, 9, 16, 17, 33].map(voidListSize), [8, 8, 8, 16, 16, 32, 64]);
  assert.throws(() => voidListSize(-1));
});

test("entries must be lowercase, strictly ascending and exactly a band size", () => {
  assert.equal(isValidVoidEntries(G.entries), true);
  assert.equal(isValidVoidEntries([...G.entries].reverse()), false);
  assert.equal(isValidVoidEntries([G.entries[0]!, ...G.entries.slice(0, 7)]), false);
  assert.equal(isValidVoidEntries(G.entries.slice(0, 7)), false);
  assert.equal(isValidVoidEntries([...G.entries, `0x${"ff".repeat(32)}`]), false);
  assert.equal(isValidVoidEntries([G.entries[0]!.toUpperCase().replace("0X", "0x"), ...G.entries.slice(1)]), false);
  assert.throws(() => voidEntriesHash(G.entries.slice(0, 7)));
});

test("padding keeps every real tag once, and fills to the band", async () => {
  const padded = padVoidEntries([G.voidTag, G.voidTag], await counterRandom());
  assert.equal(padded.length, 8);
  assert.equal(padded.filter((e) => e === G.voidTag).length, 1);
  const nine = Array.from({ length: 9 }, (_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}`);
  assert.equal(padVoidEntries(nine).length, 16);
  assert.throws(() => padVoidEntries(["0x12"]));
});

test("a verifier: fresh lists answer, untrustworthy ones are unverified", () => {
  const base = {
    target: TARGET,
    eventId: EVENT_ID,
    header: HEADER,
    entries: G.entries,
    signature: G.voidListSig,
    expectedSigner: SIGNER,
    receiptDigest: G.receiptDigest,
    nowSecs: T0 + 60,
    seen: null as { seq: number; entriesHash: string } | null,
  };
  assert.deepEqual(checkVoidList(base), { kind: "fresh", voided: true });
  assert.deepEqual(checkVoidList({ ...base, receiptDigest: `0x${"01".repeat(32)}` }), { kind: "fresh", voided: false });
  assert.deepEqual(checkVoidList({ ...base, seen: { seq: 3, entriesHash: G.entriesHash } }), { kind: "fresh", voided: true });
  const reason = (over: Partial<typeof base>) => {
    const v = checkVoidList({ ...base, ...over });
    return v.kind === "fresh" ? "fresh" : v.reason;
  };
  assert.equal(reason({ expectedSigner: `0x${"33".repeat(20)}` }), "bad-signer");
  assert.equal(reason({ entries: [...G.entries.slice(0, 7), `0x${"ff".repeat(32)}`] }), "malformed");
  assert.equal(reason({ eventId: `0x${"cd".repeat(32)}` }), "wrong-event");
  assert.equal(reason({ nowSecs: T0 + 21_601 }), "stale");
  assert.equal(reason({ seen: { seq: 4, entriesHash: G.entriesHash } }), "rolled-back");
  assert.equal(reason({ seen: { seq: 3, entriesHash: `0x${"00".repeat(32)}` } }), "equivocated");
  assert.equal(reason({ signature: "0x00" }), "bad-signer");
  assert.equal(reason({ target: { ...TARGET, chainId: 8453 } }), "bad-signer");
});
