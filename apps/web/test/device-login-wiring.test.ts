/**
 * Signing in with an ADDED passkey (#746 step 3), pinned at the source: the store
 * is a runes module this suite cannot load, as identity-seed.test.ts notes. What
 * must hold: the server's verdict comes before anything is written; a device never
 * takes an owner's fast paths; a device cannot reach the Kernel; a removal is
 * forgotten; and a credential recovered away from keeps what it had.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const STORE = read("../src/lib/auth/auth-store.svelte.ts");
function body(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist`);
  return src.slice(start, src.indexOf("\n}\n", start));
}

test("a device's sign-in is dispatched after the tombstone check and before the owner fast path", () => {
  const login = body(STORE, "async function loginPasskeyResult(");
  const tombstone = login.indexOf("readOrphanTombstone(");
  const dispatch = login.indexOf('if (bound?.role === "device") {');
  const fastPath = login.indexOf('readCachedKernelAddress("passkey", account.address)');
  assert.ok(tombstone > 0 && dispatch > tombstone && fastPath > dispatch);
  assert.match(login, /account\.handleKind === "added" \? null : readCachedKernelAddress/);
});

test("the server's verdict comes before anything is written, and only a verdict stores the session", () => {
  const b = body(STORE, "async function _loginAddedPasskey(");
  assert.match(b, /requestSessionDelegation\([\s\S]*?\{ persist: false \},?\s*\)/);
  const verdict = b.indexOf("await deviceVerdict(");
  const firstWrite = Math.min(
    ...["_clearStaleAuthForSwitch(", "putKV(", "storeLockedSeed(", "_putDeviceBinding(", "storeSession("]
      .map((w) => b.indexOf(w))
      .filter((i) => i >= 0),
  );
  assert.ok(verdict > 0 && firstWrite > verdict, "every write after the verdict");
  assert.match(b, /if \(verdict !== "unreachable"\) \{\s*await storeSession\(/);
});

test("a device never takes the owner's caches or background owner checks", () => {
  const b = body(STORE, "async function _loginAddedPasskey(");
  for (const forbidden of ["writeCachedKernelAddress", "writeVerifiedBinding", "_scheduleKernelPrebuild", "_verifyRecoveredBindingInBackground", "_scheduleEnvelopeReprobe"]) {
    assert.doesNotMatch(b, new RegExp(forbidden), `${forbidden} must not run for a device`);
  }
});

test("a removal is forgotten; a credential recovered away from keeps its seed and binding", () => {
  const b = body(STORE, "async function _loginAddedPasskey(");
  assert.match(b, /if \(verdict === "removed"\) \{\s*await _forgetAddedPasskey\(seedAddr\);[\s\S]*?throw new DeviceRemovedError\(\);/);
  const invalid = b.slice(b.indexOf('if (verdict === "invalid")'), b.indexOf("await _clearStaleAuthForSwitch("));
  assert.match(invalid, /if \(added\) await _forgetAddedPasskey\(seedAddr\);/);
  assert.match(invalid, /throw refuseOrphanedCredential\(/);
  const forget = body(STORE, "async function _forgetAddedPasskey(");
  assert.match(forget, /_clearDeviceBinding\(seedAddress\)/);
  assert.match(forget, /_clearSeedEverywhere\(seedAddress\)/);
});

test("a device cannot reach the Kernel: the gate is the first thing _ensureKernel does", () => {
  const b = body(STORE, "async function _ensureKernel()");
  const gate = b.indexOf('?.role === "device") {');
  assert.ok(gate > 0 && gate < b.indexOf("await _ensurePasskeyKey()"), "gate before any ceremony");
  assert.match(b, /throw new MainPasskeyRequiredError\(\)/);
});

test("the envelope check reads the owner strictly and keeps the seed when someone else owns it", () => {
  const b = body(STORE, "async function _verifyPortabilityEnvelope(");
  assert.match(b, /readKernelEcdsaOwnerStrict\(opened\.preservedKernelAddress\)/);
  assert.match(b, /if \(owner === "error"\) \{[\s\S]*?return "unavailable";/);
  assert.match(b, /foreign: \{\s*preserved: opened\.preservedKernelAddress,\s*identitySeed: opened\.identitySeed,/);
});

test("an added passkey without its envelope never falls through to an account of its own", () => {
  const login = body(STORE, "async function loginPasskeyResult(");
  const guard = login.indexOf('if (account.handleKind === "added" && !override) {');
  assert.ok(guard > 0 && guard < login.indexOf("await buildKernelFromPrivateKey("), "refused before the Kernel is built");
});

test("a removal reported on any request signs the device out, once, and only a device", () => {
  const client = read("../src/lib/api/client.ts");
  assert.equal(client.match(/AuthErrorCode\.DEVICE_REMOVED\) \{\s*(\/\/[^\n]*\n\s*)*void auth\.onDeviceRemoved\(\);/g)?.length, 2, "authFetch and authStream");
  const hook = body(STORE, "async function onDeviceRemoved(");
  assert.match(hook, /if \(_forgettingDevice \|\| _kind !== "passkey" \|\| !seedAddr \|\| !_deviceRole\) return;/);
});

test("the never-derive rule and the Kernel override hold for either binding", () => {
  assert.match(body(STORE, "async function _unlockPasskeySeed("), /if \(await _boundKernelAddress\(seedAddr\)\)/);
  assert.match(body(STORE, "async function _ensureKernel()"), /const override = await _boundKernelAddress\(_seedAddress\);/);
  assert.match(STORE, /recoveryKernelFor: _boundKernelAddress,/);
  const bound = body(STORE, "async function _boundKernelFor(");
  assert.ok(bound.indexOf("_recoveryKernelFor(") < bound.indexOf("_getDeviceBindings()"), "recovered wins");
});
