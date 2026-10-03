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
  for (const sig of ["export async function addCoOwner(", "export async function removeCoOwners("]) {
    const b = body(FLOWS, sig);
    assert.match(b, /await h\.ensureKernel\(\);/);
    assert.match(b, /await setCoOwners\(h\.kernel\(\)!,/);
    assert.match(b, /h\.dropKernel\(\);/, "its root may have changed");
  }
  assert.match(body(FLOWS, "export async function removeCoOwners("), /listWithout\(acc, k\)/, "never the last passkey");
});

test("the chain decides a passkey's role: on the list = an owner here", () => {
  const login = body(STORE, "async function _loginAddedPasskey(");
  assert.match(login, /const onList = \(await readKernelSignerFor\(parent, seedAddr\)\) === seedAddr\.toLowerCase\(\);/);
  assert.match(login, /if \(verdict === "owner" \|\| onList\) \{/);
  assert.ok(login.indexOf("const onList") < login.indexOf("await clearSession();"), "read before any commit");
  assert.match(body(STORE, "async function _restoreCachedAuth("), /if \(_deviceRole && _parent\) void _upgradeIfCoOwner\(seedAddr, _parent\);/);
});

test("every owner check that decides a sign-in reads the co-owner list too", () => {
  assert.match(body(STORE, "async function _verifyPortabilityEnvelope("), /readKernelSignerFor\(opened\.preservedKernelAddress, seedAddress\)/);
  assert.match(body(STORE, "function _verifyRecoveredBindingInBackground("), /readKernelSignerFor\(kernel, eoa\)/);
  assert.match(body(STORE, "function _scheduleEnvelopeReprobe("), /readKernelOwner: \(kernel\) => readKernelSignerFor\(kernel, eoa\),/);
  assert.match(STORE, /const ownerRead = await readKernelSignerFor\(override, account\.address\);/);
  assert.doesNotMatch(body(STORE, "async function loginPasskeyResult("), /readKernelEcdsaOwnerStrict/);
});

test("sign-off fixes: list reads floored, record removal retried, removed passkeys noticed, 1271 re-checked", () => {
  const kernel = read("../src/lib/auth/kernel-account.ts");
  const rc = kernel.slice(kernel.indexOf("export async function readCoOwners("), kernel.indexOf("export async function setCoOwners("));
  assert.match(rc, /decidePinnedBlock\(\{ head: await d\.publicClient\.getBlockNumber\(\), minBlock: rememberedLandingBlock\(kernelAddress\) \}\)/, "MUST-1");
  assert.match(rc, /if \("lagging" in pin\) return "error";/);
  const sc = kernel.slice(kernel.indexOf("export async function setCoOwners("));
  assert.ok(sc.indexOf("rememberLandingBlock(builtKernel.address, blockNumber)") < sc.indexOf("const after = await readCoOwners("), "floor raised before the read-back");
  const rm = body(STORE, "async function _removeRecordAfterList(");
  assert.match(rm, /for \(const waitMs of \[0, 1500, 4000\]\)/, "SHOULD-1: retried");
  assert.match(rm, /_writePendingRemovals\(parent, \[\.\.\._readPendingRemovals\(parent\), signed\]\);\s*throw new Error\(RECORD_NOT_YET_REMOVED_MESSAGE\);/);
  assert.match(body(STORE, "async function _restoreCachedAuth("), /void _retryPendingRemovals\(\)/);
  const conf = body(STORE, "async function _removePasskeyConfirmed(");
  assert.ok(conf.indexOf("await _removeCoOwner(target);") < conf.indexOf("await _removeRecordAfterList(parent, target);"));
  assert.match(STORE, /_scheduleEnvelopeReprobe\(cachedKernel, account\.address, account\.prfSecret\);\s*_verifyCoOwnerInBackground\(cachedKernel, account\.address\);/, "SHOULD-3");
  assert.match(body(STORE, "async function _offListConfirmed("), /setTimeout\(r, 10_000\)/, "confirmed twice, never on one lagging read");
  assert.match(body(STORE, "async function _forgetThisPasskey("), /clearCachedKernelAddress\("passkey", self\);/);
  assert.match(STORE, /if \(_kind === "passkey" && _kernel\?\.sudo\.kind === "ecdsa"\) _kernel\.rootChecked = false;\s*await _ensureKernelForKind\(\);/, "SHOULD-2");
  const login = body(STORE, "async function _loginAddedPasskey(");
  assert.ok(login.indexOf('if (verdict === "removed")') < login.indexOf("const onList"), "NIT-6: no chain read before a removal");
});

test("removing your own passkey: its record first (while the session verifies), then the list, then forget - always", () => {
  const b = body(STORE, "async function _removePasskeyConfirmed(");
  const self = b.slice(b.indexOf("} else if (target === self) {"), b.indexOf("} else {", b.indexOf("} else if (target === self) {")));
  assert.ok(self.indexOf("await revokeDeviceGrant(signed.revoke, signed.revokeSig);") < self.indexOf("await _removeCoOwner(self);"), "record before list");
  assert.match(self, /if \(!res\.ok && res\.code !== "not-found"\) throw/, "the first passkey has no record");
  assert.match(self, /\} finally \{\s*await _forgetThisPasskey\(self\);\s*\}/, "forgotten here whatever the list change did");
  // Other devices: off the list first.
  const other = b.slice(b.lastIndexOf("} else {"));
  assert.ok(other.indexOf("await _removeCoOwner(target);") < other.indexOf("await _removeRecordAfterList(parent, target);"));
});
