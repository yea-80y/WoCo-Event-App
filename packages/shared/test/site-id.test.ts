/**
 * Site ids that prove their owner (`src/site/site-id.ts`).
 *
 * The vectors are the format: a site made with these ids is found, and its owner
 * recognised, only while the derivation gives the same bytes. A failing vector
 * means every site made so far has just been orphaned from its owner.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { isOwnedSiteIdShape, newOwnedSiteId, ownedSiteId, siteIdOwnedBy } from "../src/site/site-id.js";

const ALICE = "0x2b6e834afbf4cfaa8990e3205de02e07ee95fe5d";
const BOB = "0x0000000000000000000000000000000000000001";

test("frozen vectors", () => {
  assert.equal(ownedSiteId(ALICE, "000000000001"), "s2-000000000001-baa5af59223a6fa5448d53cdd096d05fe34e4e26");
  assert.equal(ownedSiteId(BOB, "0123456789ab"), "s2-0123456789ab-80bc5a57a36872df8eb59bd5d1324301cb4c74ff");
});

test("an id is its owner's and nobody else's", () => {
  const id = ownedSiteId(ALICE, "000000000001");
  assert.equal(siteIdOwnedBy(id, ALICE), true);
  assert.equal(siteIdOwnedBy(id, BOB), false);
});

test("the owner's address is compared without its letter case", () => {
  const checksummed = "0x2B6E834AfBF4cFAa8990E3205dE02E07eE95Fe5D";
  assert.equal(ownedSiteId(checksummed, "000000000001"), ownedSiteId(ALICE, "000000000001"));
  assert.equal(siteIdOwnedBy(ownedSiteId(ALICE, "000000000001"), checksummed), true);
});

test("the nonce is part of what is proved", () => {
  const id = ownedSiteId(ALICE, "000000000001");
  const otherNonce = id.replace("s2-000000000001-", "s2-000000000002-");
  assert.equal(isOwnedSiteIdShape(otherNonce), true);
  assert.equal(siteIdOwnedBy(otherNonce, ALICE), false);
});

test("every character of the tag counts", () => {
  const id = ownedSiteId(ALICE, "000000000001");
  for (const at of [16, 35, id.length - 1]) {
    const flipped = id.slice(0, at) + (id[at] === "0" ? "1" : "0") + id.slice(at + 1);
    assert.equal(siteIdOwnedBy(flipped, ALICE), false, `character ${at}`);
  }
});

test("the tag is 20 bytes", () => {
  const id = ownedSiteId(ALICE, "000000000001");
  assert.equal(id.length, 56);
  assert.equal(isOwnedSiteIdShape(id.slice(0, -2)), false);
  assert.equal(isOwnedSiteIdShape(id + "00"), false);
});

test("an old random id has no owner by arithmetic", () => {
  for (const old of ["mvk4388p-rm7dnip", "site-12345678", "", "s2-", "S2-000000000001-baa5af59223a6fa5448d53cdd096d05fe34e4e26"]) {
    assert.equal(isOwnedSiteIdShape(old), false, old);
    assert.equal(siteIdOwnedBy(old, ALICE), false, old);
  }
});

test("malformed input is refused, never thrown on", () => {
  const id = ownedSiteId(ALICE, "000000000001");
  assert.equal(siteIdOwnedBy(id, "not an address"), false);
  assert.equal(siteIdOwnedBy(id, ALICE.slice(0, -1)), false);
  assert.equal(siteIdOwnedBy(undefined as unknown as string, ALICE), false);
  assert.equal(siteIdOwnedBy(id, undefined as unknown as string), false);
  assert.equal(isOwnedSiteIdShape(42 as unknown as string), false);
});

test("making an id needs a real address and a well-formed nonce", () => {
  assert.throws(() => ownedSiteId("0x0", "000000000001"), /account address/);
  assert.throws(() => ownedSiteId(ALICE, "1"), /nonce/);
  assert.throws(() => ownedSiteId(ALICE, "00000000000G"), /nonce/);
  assert.throws(() => ownedSiteId(ALICE, "0000000000AB"), /nonce/);
});

test("a fresh id is the owner's, differs each time, and fits the id gates", () => {
  const a = newOwnedSiteId(ALICE);
  const b = newOwnedSiteId(ALICE);
  assert.notEqual(a, b);
  assert.equal(siteIdOwnedBy(a, ALICE), true);
  assert.equal(siteIdOwnedBy(a, BOB), false);
  // The server's two id gates: `isSafeIdParam` and the events-index reader.
  assert.match(a, /^[0-9a-zA-Z_-]{8,64}$/);
});
