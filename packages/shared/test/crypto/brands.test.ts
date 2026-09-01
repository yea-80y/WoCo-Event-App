/**
 * Branded-type constructors — the #445-class value guards at JSON boundaries.
 * Non-canonical input is REFUSED, never normalised: a 0x prefix, uppercase
 * hex, or wrong length must fail at ingestion, not be laundered into a store
 * that later readers trust.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  asHolderPubkey,
  asEncryptionPubkey,
  asIssuerAddress,
  isHolderPubkey,
  isIssuerAddress,
} from "../../src/crypto/brands.js";

const KEY = "ab".repeat(32);
const ADDR = "0x" + "cd".repeat(20);

test("canonical values pass through unchanged", () => {
  assert.equal(asHolderPubkey(KEY), KEY);
  assert.equal(asEncryptionPubkey(KEY), KEY);
  assert.equal(asIssuerAddress(ADDR), ADDR);
});

test("a 0x-prefixed pubkey is REFUSED, not stripped — the #445 defect class", () => {
  assert.throws(() => asHolderPubkey("0x" + KEY), /invalid holder pubkey/);
  assert.throws(() => asEncryptionPubkey("0x" + KEY), /invalid encryption pubkey/);
});

test("uppercase hex is refused, not case-folded", () => {
  assert.throws(() => asHolderPubkey(KEY.toUpperCase()));
  assert.throws(() => asIssuerAddress(ADDR.toUpperCase()));
});

test("wrong lengths and wrong kinds are refused", () => {
  assert.throws(() => asHolderPubkey(KEY.slice(0, 62)));
  assert.throws(() => asHolderPubkey(KEY + "ab"));
  assert.throws(() => asHolderPubkey(ADDR), /invalid holder pubkey/); // an address is not a key
  assert.throws(() => asIssuerAddress(KEY), /invalid issuer address/); // a key is not an address
  assert.throws(() => asHolderPubkey(undefined));
  assert.throws(() => asHolderPubkey(42));
  assert.throws(() => asHolderPubkey(""));
});

test("guards mirror the constructors without throwing", () => {
  assert.equal(isHolderPubkey(KEY), true);
  assert.equal(isHolderPubkey("0x" + KEY), false);
  assert.equal(isIssuerAddress(ADDR), true);
  assert.equal(isIssuerAddress(KEY), false);
});

test("the 64-hex shape can never be a valid issuer address and vice versa", () => {
  // Shape-distinctness is part of the v2 design: 42-char addresses vs 64-char
  // keys means a wrong-kind value fails validation instead of verifying
  // against garbage.
  assert.equal(isHolderPubkey(ADDR), false);
  assert.equal(isIssuerAddress("0x" + KEY), false);
});
