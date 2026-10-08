/**
 * The email -> passkey upgrade's store side (#746), pinned at the source: the store
 * is a runes module this suite cannot load. The flow itself runs under test in
 * upgrade-to-passkey.test.ts; what must hold here is how the store lends to it and
 * how an upgraded email key is turned away:
 *  - an email sign-in is refused once its account opens with a passkey - on this
 *    device at once (the tombstone), elsewhere off the chain: in the slow path before
 *    anything is written, after the fast path in the background, and when a fresh
 *    session is refused (MUST-2 of the design consult: else a SESSION_INVALID loop);
 *  - the switch the store sends lists exactly what the flow asks for, signed by the
 *    email key's own Kernel;
 *  - adopting the passkey writes the store's state; finalize wipes the old seed (PQ2);
 *    the session the email key signed ends last (the order itself is the flow's
 *    `commitUpgrade`, run under test in upgrade-to-passkey.test.ts);
 *  - a resume costs one storage read unless this device holds a marker.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const STORE = read("../src/lib/auth/auth-store.svelte.ts");
const CLIENT = read("../src/lib/api/client.ts");
function body(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist`);
  return src.slice(start, src.indexOf("\n}\n", start));
}

test("an email sign-in checks this device's upgrade tombstone before any path", () => {
  const b = body(STORE, "async function loginWeb3Auth(");
  const tombstone = b.indexOf('readOrphanTombstone("web3auth", address)');
  const fastPath = b.indexOf('readCachedKernelAddress("web3auth", address)');
  assert.ok(tombstone > 0 && fastPath > tombstone, "tombstone first");
  assert.match(b, /if \(upgraded\) throw await _refuseUpgradedEmailLogin\(/);
});

test("the slow path refuses an email key that is off the list before anything is written", () => {
  const b = body(STORE, "async function loginWeb3Auth(");
  const slow = b.slice(b.indexOf("const kernel = await buildKernelFromPrivateKey("));
  const check = slow.indexOf("=== NOT_ON_LIST");
  const firstWrite = slow.indexOf("_clearStaleAuthForSwitch(");
  assert.ok(check > 0 && firstWrite > check);
  assert.match(slow, /readKernelSignerFor\(kernel\.address, address\)\) === NOT_ON_LIST\) \{\s*throw await _refuseUpgradedEmailLogin\(/);
});

test("the fast path makes no chain read, so the background check follows it", () => {
  const b = body(STORE, "async function loginWeb3Auth(");
  const fast = b.slice(b.indexOf("if (cachedKernel) {"), b.indexOf("// Kernelize"));
  assert.match(fast, /_verifyEmailKeyInBackground\(cachedKernel, address\)/);
});

test("a refusal drops the email login's fast-path entries and its Web3Auth session", () => {
  const b = body(STORE, "async function _refuseUpgradedEmailLogin(");
  assert.match(b, /clearCachedKernelAddress\("web3auth", eoa\)/);
  assert.match(b, /logoutWeb3Auth\(\)/);
  assert.match(b, /UPGRADED_TO_PASSKEY_MESSAGE/);
  const bg = body(STORE, "function _verifyEmailKeyInBackground(");
  assert.match(bg, /!== NOT_ON_LIST\) return;/, "only a key provably off the list is signed out");
  assert.match(bg, /if \(!still\) return;[\s\S]*logout\(\{ force: true \}\)/, "and only the session it was launched for");
});

test("a fresh session refused too asks the store whether the email key was upgraded away", () => {
  const n = CLIENT.match(/sessionHealth\.markEnded\(\);\s*(?:\/\/[^\n]*\n\s*)?auth\.onSessionRejected\(\);/g)?.length ?? 0;
  assert.equal(n, 2, "both the request path and the stream path");
  assert.match(body(STORE, "function onSessionRejected("), /_kind === "web3auth"[\s\S]*_verifyEmailKeyInBackground\(/);
});

test("the switch is the flow's list, sent by the email key's own Kernel", () => {
  const b = body(STORE, "function _upgradeHost(");
  const kernel = b.slice(b.indexOf("emailKernel: async () => {"));
  assert.match(kernel, /await _ensureKernelForWeb3Auth\(\);/);
  assert.match(kernel, /setCoOwners: \(root, signers\) => k\.setCoOwners\(kernel, root, signers\)/);
});

test("adopting the passkey writes the binding, the pin and the identity keys, and drops the email key from memory", () => {
  const b = body(STORE, "function _upgradeHost(");
  const adopt = b.slice(b.indexOf("adoptPasskey: async"), b.indexOf("finalizeDeps: () =>"));
  const at = (x: string) => {
    const i = adopt.indexOf(x);
    assert.ok(i >= 0, x);
    return i;
  };
  const order = ["_putRecoveryBinding(passkey, parent)", "pinPasskeyCredential(marker.credential)", 'putKV(StorageKeys.AUTH_KIND, "passkey"', '_kind = "passkey"'].map(at);
  assert.deepEqual([...order].sort((x, y) => x - y), order);
  assert.match(adopt, /_web3authPrivateKey = null;/);
  // An Undo in another tab may have dropped the locked seed; the tab that commits holds it (Fable sign-off).
  assert.match(adopt, /if \(live\) await storeLockedSeed\(passkey, parent, live\.seed, live\.prfSecret\);/);
  assert.doesNotMatch(adopt, /_restoreAuthAfterRotation|resetSession/, "the session is killed by endEmailSession, last");
});

test("finalize wipes the old seed and tombstones the email key (PQ2); the email session ends last", () => {
  const b = body(STORE, "function _upgradeHost(");
  assert.match(b, /wipeOldSeed: \(emailKey\) => clearIdentitySeed\(emailKey\)/);
  assert.match(b, /writeOrphanTombstone\("web3auth", emailKey, \{ kernel: parent, owner: passkey \}\)/);
  assert.match(b, /_setPendingPasskeyRecord\(\{ credentialId, parent \}\)/);
  const end = b.slice(b.indexOf("endEmailSession: async"));
  assert.ok(end.indexOf("logoutWeb3Auth()") < end.indexOf("await _restoreAuthAfterRotation();"));
});

test("a resume costs one storage read unless this device holds a marker", () => {
  const b = body(STORE, "function _resumeUpgrade(");
  assert.match(b, /!_upgradeModules \|\| _kind !== "passkey"/, "nothing to resume where the flow is not registered (site bundles)");
  const read = b.indexOf("getItem(upgradeMarkerKey(_parent))");
  const load = b.indexOf("_upgradeFlow()");
  assert.ok(read > 0 && load > read);
  assert.match(STORE, /void _retryPendingRemovals\(\)\.catch\(\(\) => \{\}\);\s*void _resumeUpgrade\(\);/, "at restore");
  assert.match(STORE, /void _maybeWritePasskeyRecord\(\);\s*void _resumeUpgrade\(\);/, "at a passkey session mint");
});

test("the flow's resume goes through the store's single-flight path, after a session", () => {
  const b = body(STORE, "function _upgradeHost(");
  assert.match(b, /resumeLater: \(\) => void ensureSession\(\)\.then\(\(ok\) => \(ok \? _resumeUpgrade\(\) : undefined\)\)/);
});

test("the store never imports the flow: the main app registers it, so site bundles do not carry it", () => {
  // Type-only `import("...")` references compile away; a dynamic import is a call.
  assert.doesNotMatch(STORE, /(?:await\s+|[[(,]\s*)import\("\.\/upgrade-to-passkey(-live)?\.js"\)/, "no dynamic import either");
  assert.doesNotMatch(STORE, /^import [^;]*"\.\/upgrade-to-passkey(-live)?\.js"/m);
  const main = read("../src/main.ts");
  assert.ok(main.indexOf("auth.registerUpgradeFlow(") < main.indexOf("mount(App"), "registered before the app boots");
  for (const entry of ["../src/multi-site-main.ts", "../src/site-main.ts"]) {
    assert.doesNotMatch(read(entry), /registerUpgradeFlow|upgrade-to-passkey/, entry);
  }
});
