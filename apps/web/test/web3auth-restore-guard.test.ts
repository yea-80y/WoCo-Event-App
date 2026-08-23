/**
 * The cold-restore pairing matrix (#183): a live Web3Auth key is adopted only
 * for the identity this device's storage names.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decideWeb3AuthKeyRetry, decideWeb3AuthRestore } from "../src/lib/auth/web3auth-restore-guard.js";

const EOA_A = "0x" + "aa".repeat(20);
const EOA_B = "0x" + "bb".repeat(20);
const KERNEL_A = "0x" + "a1".repeat(20);
const KEY = "0x" + "11".repeat(32);

test("restored + matching EOA → adopt with the key", () => {
  assert.deepEqual(
    decideWeb3AuthRestore({ restore: { status: "restored", address: EOA_A, privateKey: KEY }, storedParent: KERNEL_A, storedPodAddr: EOA_A }),
    { action: "adopt", privateKey: KEY },
  );
  // Case and whitespace never decide identity.
  assert.deepEqual(
    decideWeb3AuthRestore({ restore: { status: "restored", address: EOA_A.toUpperCase().replace("0X", "0x"), privateKey: KEY }, storedParent: KERNEL_A, storedPodAddr: ` ${EOA_A} ` }),
    { action: "adopt", privateKey: KEY },
  );
});

test("restored + DIFFERENT EOA → clear (a different person is signed in) — the #183 case", () => {
  assert.deepEqual(
    decideWeb3AuthRestore({ restore: { status: "restored", address: EOA_B, privateKey: KEY }, storedParent: KERNEL_A, storedPodAddr: EOA_A }),
    { action: "clear", reason: "identity-mismatch" },
  );
  assert.deepEqual(
    decideWeb3AuthRestore({ restore: { status: "restored", address: "", privateKey: KEY }, storedParent: KERNEL_A, storedPodAddr: EOA_A }),
    { action: "clear", reason: "identity-mismatch" },
  );
});

test("expired → clear; missing identity → clear regardless of the session", () => {
  assert.deepEqual(
    decideWeb3AuthRestore({ restore: { status: "expired" }, storedParent: KERNEL_A, storedPodAddr: EOA_A }),
    { action: "clear", reason: "expired" },
  );
  assert.deepEqual(
    decideWeb3AuthRestore({ restore: { status: "restored", address: EOA_A, privateKey: KEY }, storedParent: KERNEL_A, storedPodAddr: null }),
    { action: "clear", reason: "no-identity" },
  );
  assert.deepEqual(
    decideWeb3AuthRestore({ restore: { status: "unavailable" }, storedParent: undefined, storedPodAddr: EOA_A }),
    { action: "clear", reason: "no-identity" },
  );
});

test("unavailable + stored identity → adopt without key (transient, retry later)", () => {
  assert.deepEqual(
    decideWeb3AuthRestore({ restore: { status: "unavailable" }, storedParent: KERNEL_A, storedPodAddr: EOA_A }),
    { action: "adopt-without-key" },
  );
});

test("background retry: the arriving key must match the adopted identity", () => {
  assert.deepEqual(decideWeb3AuthKeyRetry({ restore: { status: "restored", address: EOA_A, privateKey: KEY }, adoptedPodAddr: EOA_A }), { action: "adopt", privateKey: KEY });
  assert.deepEqual(decideWeb3AuthKeyRetry({ restore: { status: "restored", address: EOA_B, privateKey: KEY }, adoptedPodAddr: EOA_A }), { action: "clear" });
  assert.deepEqual(decideWeb3AuthKeyRetry({ restore: { status: "restored", address: EOA_A, privateKey: KEY }, adoptedPodAddr: null }), { action: "clear" });
  assert.deepEqual(decideWeb3AuthKeyRetry({ restore: { status: "expired" }, adoptedPodAddr: EOA_A }), { action: "stop" });
  assert.deepEqual(decideWeb3AuthKeyRetry({ restore: { status: "unavailable" }, adoptedPodAddr: EOA_A }), { action: "retry" });
});
