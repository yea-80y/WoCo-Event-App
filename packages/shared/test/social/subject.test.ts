/**
 * Subject derivation is the one place likes can fragment silently — two call
 * sites hashing the same profile differently split its followers with no error
 * on either side. These vectors are the spec; a change here is a change to
 * every statement already written.
 *
 * The profile vectors are computed INDEPENDENTLY (plain EIP-137 namehash below)
 * rather than snapshotted from our own output. A self-snapshot would happily
 * lock in a derivation that had already drifted away from the node the
 * L2Registry actually mints, which is the only thing that makes the live owner
 * resolvable from chain.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes, concatBytes } from "@noble/hashes/utils.js";
import {
  socialProfileSubject,
  socialEventSubject,
  followProfileSubject,
} from "../../src/social/subject.js";
import { profileSubject } from "../../src/likes/subject.js";

/** EIP-137 namehash, written out longhand so the vectors do not depend on us. */
function namehash(name: string): string {
  let node: ReturnType<typeof keccak_256> = new Uint8Array(32);
  const labels = name.split(".");
  for (let i = labels.length - 1; i >= 0; i--) {
    node = keccak_256(concatBytes(node, keccak_256(utf8ToBytes(labels[i]!))));
  }
  return `0x${bytesToHex(node)}`;
}

test("profile subject is the real ENS node under woco.eth", () => {
  assert.equal(
    socialProfileSubject("rita"),
    "0x2886e2427f6d8f2ca2358f5c3af6e5d22ca481fda415a010033d63e10067894e",
  );
  assert.equal(socialProfileSubject("rita"), namehash("rita.woco.eth"));
  assert.equal(
    socialProfileSubject("altontowers"),
    "0x98755af2fb19956264cd73745fc27b49aec0fa747b113440a7080b6a964490f7",
  );
});

test("profile subject delegates rather than reimplementing", () => {
  // A second copy of this derivation is the fragmentation failure itself.
  assert.equal(socialProfileSubject("rita"), profileSubject("rita"));
});

test("profile subject is case- and whitespace-stable", () => {
  const canonical = socialProfileSubject("altontowers");
  assert.equal(socialProfileSubject("AltonTowers"), canonical);
  assert.equal(socialProfileSubject("  altontowers  "), canonical);
});

test("follow targets an identity, reusing the identity derivation", () => {
  assert.equal(followProfileSubject("rita"), socialProfileSubject("rita"));
});

test("event subject normalises case rather than fragmenting on it", () => {
  const lower = `0x${"ab".repeat(32)}`;
  assert.equal(socialEventSubject(`0x${"AB".repeat(32)}`), lower);
  assert.equal(socialEventSubject(`  ${lower}  `), lower);
});

test("event subject rejects anything that is not a bytes32", () => {
  // The frozen topic scheme has no defined behaviour for another width, so a
  // wrong-width id must fail loudly rather than derive a plausible topic.
  assert.throws(() => socialEventSubject("0xdeadbeef"), /bytes32/);
  assert.throws(() => socialEventSubject("ab".repeat(32)), /bytes32/); // missing 0x
  assert.throws(() => socialEventSubject(""), /bytes32/);
});
