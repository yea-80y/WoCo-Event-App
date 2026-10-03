/**
 * Every passkey a co-owner (#746): the wiring in the store, pinned at the source
 * (the flows touch WebAuthn, the chain and the server, so their ORDER is what a unit
 * test can hold). What each pin protects is in its message.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const STORE = read("../src/lib/auth/auth-store.svelte.ts");
const FLOWS = read("../src/lib/auth/co-owner-flows.ts");
function body(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `missing: ${signature}`);
  const ends = ["\nasync function ", "\nfunction ", "\nexport "].map((m) => src.indexOf(m, start + signature.length));
  const end = ends.filter((i) => i > 0).sort((x, y) => x - y)[0] ?? src.length;
  return src.slice(start, end);
}

test("the Kernel used for signing is opened with the validator the account really has", () => {
  const b = body(STORE, "async function _ensureKernel()");
  assert.match(b, /if \(_kernel\?\.rootChecked\) return;/, "a sign-in build (ECDSA assumed) is re-checked before the first signature");
  assert.match(b, /const root = at \? await readKernelRoot\(at\) : "none";/);
  assert.match(b, /root: root === "weighted" \? "weighted" : "ecdsa",/);
});

test("linking and adding put the new key on the list BEFORE its device record (and before the new device is told)", () => {
  const approve = body(STORE, "async function approveDeviceLink(");
  assert.match(approve, /grant: \(grantee, credentialTag\) => _addCoOwnerWithRecord\(grantee, \(\) => _grantDevice\(ownerKey, parent, grantee, credentialTag\)\),/);
  assert.match(approve, /revoke: \(grantee\) => _removePasskeyConfirmed\(grantee\),/, "the undelivered-answer cleanup does not ask again");
  const add = body(STORE, "async function addPasskeyOnThisDevice(");
  assert.match(add, /await _freshMainPasskey\(\);/, "adding asks fresh");
  assert.match(add, /await _addCoOwnerWithRecord\(added\.address, \(\) =>\s*_grantDevice\(ownerKey, parent, added\.address,/);
  // On the list first; a failed record takes it off again - never full control without a record.
  const both = body(FLOWS, "export async function addCoOwnerWithRecord<T>(");
  assert.ok(both.indexOf("const added = await addCoOwner(h, key);") < both.indexOf("const result = await record();"));
  // Only what this call added is taken back, and a failed undo is never silent.
  assert.match(both, /if \(added\) \{\s*try \{\s*await removeCoOwner\(h, key\);/);
  assert.match(both, /throw new Error\(\s*"The new passkey was added to your account but couldn't be saved/);
  assert.match(body(FLOWS, "export async function addCoOwner("), /if \(list\.includes\(key\.toLowerCase\(\)\)\) return false;/);
  // The flows load on the tap; the store only lends its state.
  assert.match(body(STORE, "async function _addCoOwnerWithRecord<T>("), /\(await import\("\.\/co-owner-flows\.js"\)\)\.addCoOwnerWithRecord\(_coOwnerHost\(\), key, record\)/);
  assert.doesNotMatch(STORE, /^import [^\n]*co-owner-flows/m);
});

test("a list change is signed by this device and the Kernel is rebuilt after it", () => {
  for (const sig of ["export async function addCoOwner(", "export async function removeCoOwner("]) {
    const b = body(FLOWS, sig);
    assert.match(b, /await h\.ensureKernel\(\);/);
    assert.match(b, /await setCoOwners\(h\.kernel\(\)!,/);
    assert.match(b, /h\.dropKernel\(\);/, "its root may have changed");
  }
  assert.match(body(FLOWS, "export async function removeCoOwner("), /listWithout\(list, key\)/, "never the last passkey");
});

test("the chain decides a passkey's role: on the list = an owner here", () => {
  const login = body(STORE, "async function _loginAddedPasskey(");
  assert.match(login, /const onList = \(await readKernelSignerFor\(parent, seedAddr\)\) === seedAddr\.toLowerCase\(\);/);
  assert.match(login, /if \(verdict === "owner" \|\| onList\) \{/);
  assert.ok(login.indexOf("const onList") < login.indexOf('if (verdict === "removed")'), "read before any commit");
  assert.match(body(STORE, "async function _restoreCachedAuth("), /if \(_deviceRole && _parent\) void _upgradeIfCoOwner\(seedAddr, _parent\);/);
});

test("every owner check that decides a sign-in reads the co-owner list too", () => {
  assert.match(body(STORE, "async function _verifyPortabilityEnvelope("), /readKernelSignerFor\(opened\.preservedKernelAddress, seedAddress\)/);
  assert.match(body(STORE, "function _verifyRecoveredBindingInBackground("), /readKernelSignerFor\(kernel, eoa\)/);
  assert.match(body(STORE, "function _scheduleEnvelopeReprobe("), /readKernelOwner: \(kernel\) => readKernelSignerFor\(kernel, eoa\),/);
  assert.match(STORE, /const ownerRead = await readKernelSignerFor\(override, account\.address\);/);
  assert.doesNotMatch(body(STORE, "async function loginPasskeyResult("), /readKernelEcdsaOwnerStrict/);
});
