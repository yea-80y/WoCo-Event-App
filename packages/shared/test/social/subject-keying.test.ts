/**
 * A profile subject is an ADDRESS (owner decision, 2026-09-03).
 *
 * It used to be the namehash of the holder's `{label}.woco.eth`, which looks
 * like a sovereign identity and is not: WoCo governance can reassign any name
 * (`adminTransfer`), a re-minter inherits a released one the same block, and
 * every subname's meaning is contingent on `woco.eth` custody. Under namehash
 * keying each of those moved the AUDIENCE. Under address keying none of them
 * can touch it.
 *
 * The property worth pinning is that the derivation cannot silently drift:
 * `subject` is a frozen opaque bytes32, so two call sites deriving it
 * differently split a person's followers across mismatched ids and BOTH sides
 * still verify. Nothing detects that but a test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  socialProfileSubject,
  followProfileSubject,
  socialEventSubject,
  addressFromProfileSubject,
} from "../../src/social/subject.js";

const ADDR = "0x1234567890abcdef1234567890abcdef12345678";

test("a profile subject is the address, left-padded to 32 bytes", () => {
  assert.equal(
    socialProfileSubject(ADDR),
    "0x000000000000000000000000" + ADDR.slice(2),
  );
});

test("the subject is always 32 bytes and lowercase", () => {
  const s = socialProfileSubject(ADDR.toUpperCase());
  assert.match(s, /^0x[0-9a-f]{64}$/);
});

test("case and surrounding space cannot fragment an audience", () => {
  // The same person reached from a contract read, a feed payload and a URL must
  // land on ONE subject. A mixed-case address deriving a different id would
  // split their followers with no error anywhere.
  const canonical = socialProfileSubject(ADDR);
  assert.equal(socialProfileSubject(ADDR.toUpperCase()), canonical);
  assert.equal(socialProfileSubject(`  ${ADDR}  `), canonical);
});

test("follows and profile likes derive the SAME subject", () => {
  // Two functions exist so "follow" has no reachable event overload, not
  // because they key differently.
  assert.equal(followProfileSubject(ADDR), socialProfileSubject(ADDR));
});

test("a non-address throws rather than deriving a plausible id", () => {
  for (const bad of ["", "0x", "punkpub", "punkpub.woco.eth", "0x1234", `0x${"a".repeat(64)}`]) {
    assert.throws(() => socialProfileSubject(bad), /profile subject must be/);
  }
});

test("an address subject is its own inverse, so display needs no reverse map", () => {
  // This is what makes the label cache unnecessary: a Following list holding
  // only bytes32 can resolve each entry straight back to an account. A namehash
  // is one-way and could not.
  assert.equal(addressFromProfileSubject(socialProfileSubject(ADDR)), ADDR);
});

test("a non-address subject does not decode to an address", () => {
  // An event subject is a full-width bytes32; reading it as a padded address
  // would invent an account that does not exist.
  const eventish = `0x${"ab".repeat(32)}`;
  assert.equal(addressFromProfileSubject(eventish), null);
  assert.equal(addressFromProfileSubject("not-a-subject"), null);
});

test("events keep their on-chain id, which is NOT an address", () => {
  const eid = `0x${"cd".repeat(32)}`;
  assert.equal(socialEventSubject(eid), eid);
  assert.notEqual(socialEventSubject(eid), socialProfileSubject(ADDR));
});

test("an event subject of the wrong width throws", () => {
  assert.throws(() => socialEventSubject("0xdeadbeef"), /event subject must be/);
});

test("a profile and an event can never collide", () => {
  // Padding guarantees it: a profile subject has 24 leading zero nibbles, and
  // an event id that happened to share them would decode as an address, which
  // the previous test forbids relying on.
  const p = socialProfileSubject(ADDR);
  assert.equal(p.slice(2, 26), "0".repeat(24));
});
