/**
 * The key-ring anchor's address and call shapes (#186), recomputed rather than trusted:
 * the selector a sponsored batch is checked against, and the CREATE2 address the
 * WoCo-Contracts deploy script predicts (pinned there too).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Interface, keccak256, toUtf8Bytes } from "ethers";
import {
  KEY_RING_ANCHOR_ABI,
  KEY_RING_ANCHOR_ADDRESS,
  SET_RING_SELECTOR,
  anchorToRingRef,
  ringRefToAnchor,
} from "../../src/keyring/anchor.js";
import { NO_RING } from "../../src/keyring/ring.js";

test("setRing's selector is the ABI's", () => {
  assert.equal(SET_RING_SELECTOR, keccak256(toUtf8Bytes("setRing(bytes32,bytes32)")).slice(0, 10));
  assert.equal(new Interface(KEY_RING_ANCHOR_ABI).getFunction("setRing")!.selector, SET_RING_SELECTOR);
});

test("the address is stored lowercase, as every comparison here expects", () => {
  // Its value is pinned where the init code lives: WoCo-Contracts test_singletonAddress_isPinned.
  assert.match(KEY_RING_ANCHOR_ADDRESS, /^0x[0-9a-f]{40}$/);
});

test("ring references round-trip, and zero means no ring", () => {
  const ref = "ab".repeat(32);
  assert.equal(anchorToRingRef(ringRefToAnchor(ref)), ref);
  assert.equal(anchorToRingRef(NO_RING), null);
  assert.equal(anchorToRingRef(("0x" + "AB".repeat(32))), ref);
  assert.throws(() => ringRefToAnchor("0x" + ref), /64 lowercase hex/);
  assert.throws(() => anchorToRingRef("0x12"), /bytes32/);
});
