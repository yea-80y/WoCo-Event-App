/**
 * Where the passkey-record guard sits in the login (#746). The behaviour is
 * unit-tested in passkey-record.test.ts; what those tests cannot see is ORDER:
 * the check must run before the login commits anything for the derived account,
 * only on a sign-in, and the record must be written only from a creation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const store = readFileSync(fileURLToPath(new URL("../src/lib/auth/auth-store.svelte.ts", import.meta.url)), "utf8");

function loginBody(): string {
  const start = store.indexOf("async function loginPasskeyResult(");
  assert.ok(start > 0, "loginPasskeyResult must exist");
  const end = store.indexOf("\nasync function ", start + 10);
  return store.slice(start, end);
}

function fnBody(name: string): string {
  const start = store.indexOf(`async function ${name}(`);
  assert.ok(start > 0, `${name} must exist`);
  return store.slice(start, store.indexOf("\nasync function ", start + 10));
}

test("the guard runs on sign-in, after the account is derived and before anything is committed", () => {
  const body = loginBody();
  const kernel = body.indexOf("const kernel = await buildKernelFromPrivateKey(");
  const guard = body.indexOf('if (mode === "signin") await _guardPasskeyRecord(account, kernel.address);');
  const commit = body.indexOf("await _clearStaleAuthForSwitch(kernel.address);", kernel);
  assert.ok(kernel > 0 && guard > kernel, "the guard needs the derived account address; a new passkey has no record");
  assert.ok(commit > guard, "the guard must refuse before the login clears or writes any state");
});

test("every commit in a passkey sign-in is preceded by the record check for the same account", () => {
  // From another device a sign-in commits only on a confirmed record (#746): each
  // branch that writes PARENT_ADDRESS must have run the guard for that same address
  // before it clears or writes anything. Platform answers stay read-free on the two
  // fast paths, so the check there is gated on "cross-platform".
  const body = loginBody();
  const commits = [...body.matchAll(/await putKV\(StorageKeys\.PARENT_ADDRESS, ([\w.]+)\);/g)].map((m) => m[1]);
  assert.deepEqual(commits, ["cachedKernel", "parent", "kernel.address"], "a new commit path needs a guard and a test");
  const guards: Record<string, string> = {
    cachedKernel: 'if (account.attachment === "cross-platform") await _guardPasskeyRecord(account, cachedKernel);',
    parent: 'if (account.attachment === "cross-platform") await _guardPasskeyRecord(account, parent);',
    "kernel.address": 'if (mode === "signin") await _guardPasskeyRecord(account, kernel.address);',
  };
  for (const parent of commits) {
    const write = body.indexOf(`await putKV(StorageKeys.PARENT_ADDRESS, ${parent});`);
    const clear = body.lastIndexOf(`await _clearStaleAuthForSwitch(${parent});`, write);
    const guard = body.lastIndexOf(guards[parent], clear);
    assert.ok(clear > 0 && guard > 0, `the ${parent} branch must check the record`);
    assert.equal(
      body.slice(guard, clear).includes("_clearStaleAuthForSwitch("),
      false,
      `the ${parent} guard belongs to its own branch`,
    );
  }
  assert.equal(body.split("_guardPasskeyRecord(").length - 1, 3);
});

test("an added passkey's sign-in checks the record, with its attachment, before minting anything", () => {
  const fn = fnBody("_loginAddedPasskey");
  const guard = fn.indexOf("await _guardPasskeyRecord(account, parent);");
  const mint = fn.indexOf("await requestSessionDelegation(");
  assert.ok(guard > 0 && mint > guard);
});

test("the guard helper passes the attachment and this device's pending record", () => {
  const fn = fnBody("_guardPasskeyRecord");
  assert.match(
    fn,
    /guardPasskeyRecord\(account\.credentialId, parent, account\.attachment, \{\s*pending: parsePendingPasskeyRecord\(_pendingPasskeyRecordRaw\(\)\),\s*\}\)/,
  );
});

test("a record refusal puts back the pin the ceremony replaced - and nothing else does", () => {
  const body = loginBody();
  const ceremony = body.indexOf("await authenticatePasskey();");
  const keep = body.indexOf("replacedPin = account.replacedPin;");
  assert.ok(ceremony > 0 && keep > ceremony, "the replaced pin is captured from the ceremony");
  const catchAt = body.indexOf("} catch (e) {", keep);
  const restore = body.indexOf(
    "if (replacedPin !== undefined && RECORD_REFUSALS.has(err.name)) await _restoreReplacedPin(replacedPin);",
  );
  assert.ok(catchAt > 0 && restore > catchAt, "restored only on the failure path");
  assert.equal(body.split("_restoreReplacedPin(").length - 1, 1, "never on success");
  const set = store.slice(store.indexOf("const RECORD_REFUSALS"), store.indexOf("]);", store.indexOf("const RECORD_REFUSALS")));
  for (const name of [
    "PasskeyFromAnotherDeviceError",
    "PasskeyRecordUnreadableError",
    "PasskeyRecordMismatchError",
    "PasskeyIsBackupError",
  ]) {
    assert.ok(set.includes(`"${name}"`), name);
  }
  assert.doesNotMatch(set, /PasskeyAssertionUnavailableError/, "a cancelled sheet pinned nothing");
  const fn = store.slice(store.indexOf("async function _restoreReplacedPin("));
  assert.match(fn.slice(0, 400), /if \(pin\) await putKV\(StorageKeys\.PASSKEY_CREDENTIAL, pin\);\s*else await delKV\(StorageKeys\.PASSKEY_CREDENTIAL\);/);
});

test("the sign-in result flags an unconfirmed answer from another device for the screen", () => {
  assert.match(loginBody(), /otherDevice: err\.name === "PasskeyFromAnotherDeviceError",/);
});

test("recovery's new passkey queues its record for the account it now owns", () => {
  const fn = fnBody("recoverAndRekey");
  const pin = fn.indexOf("if (pendingCredential) await pinPasskeyCredential(pendingCredential);");
  const queue = fn.indexOf(
    "if (pendingCredential) _setPendingPasskeyRecord({ credentialId: pendingCredential.credentialId, parent: target });",
  );
  const kind = fn.indexOf("await putKV(StorageKeys.AUTH_KIND, newOwnerKind as AuthKind);");
  assert.ok(pin > 0 && queue > pin && kind > queue);
});

test("a record is queued only from a creation, the moment the account is committed", () => {
  const body = loginBody();
  const queue = body.indexOf(
    'if (mode === "create") _setPendingPasskeyRecord({ credentialId: account.credentialId, parent: kernel.address });',
  );
  const committed = body.indexOf("_parent = kernel.address;");
  const restore = body.indexOf("await _restoreCachedAuth();", committed);
  assert.ok(committed > 0 && queue > committed, "queued for the account just committed");
  assert.ok(restore > queue, "queued before anything can mint the account's first session");
  assert.equal(body.split("_setPendingPasskeyRecord(").length - 1, 1, "no other login path may queue a record");
  // Creation and recovery are the only two places a record is queued.
  assert.equal(store.split("_setPendingPasskeyRecord({").length - 1, 2);
});

test("the pending slot is read from the one key both the queue and the check use", () => {
  const fn = store.slice(store.indexOf("function _pendingPasskeyRecordRaw("));
  assert.match(fn.slice(0, 300), /return globalThis\.localStorage\?\.getItem\(PENDING_PASSKEY_RECORD_KEY\) \?\? null;/);
  assert.match(store, /globalThis\.localStorage\?\.setItem\(PENDING_PASSKEY_RECORD_KEY, JSON\.stringify\(pending\)\)/);
});

test("the pending write uses the queued slot, never prompts, and keeps the slot when unreadable", () => {
  const start = store.indexOf("async function _maybeWritePasskeyRecord(");
  const fn = store.slice(start, store.indexOf("\nasync function ", start + 10));
  assert.match(fn, /ensurePasskeyRecord\(\{ credentialId: pending\.credentialId, parent: pending\.parent \}\)/);
  assert.match(fn, /if \(!_sessionAddress\) return;/, "a background write must never mint a session");
  const keep = fn.indexOf('if (outcome === "unavailable") return;');
  const drop = fn.lastIndexOf("removeItem(PENDING_PASSKEY_RECORD_KEY)");
  assert.ok(keep > 0 && drop > keep, "an unreadable record keeps the slot for a retry");
});

test("a failed write also retries on page load, after the cached session is restored", () => {
  const branch = store.indexOf('} else if (kind === "passkey") {');
  const restore = store.indexOf("_parent = storedParent;", branch);
  assert.ok(branch > 0, "the passkey restore branch must exist");
  const cached = store.indexOf("await _restoreCachedAuth();", restore);
  const retry = store.indexOf("void _maybeWritePasskeyRecord();", restore);
  const branchEnd = store.indexOf("await clearAllAuth();", restore);
  assert.ok(restore > 0 && cached > restore && retry > cached);
  assert.ok(retry < branchEnd, "the retry belongs to this restore branch, not a later call site");
});

test("the record is read and written at the same address: topic, version 0, one route", () => {
  const mod = readFileSync(fileURLToPath(new URL("../src/lib/auth/passkey-record.ts", import.meta.url)), "utf8");
  assert.match(
    mod,
    /readContentFeedAtVersion\(address, PASSKEY_RECORD_TOPIC, 0, \{\s*route: await routeFor\(\),\s*thorough: opts\.thorough === true,\s*\}\)/,
  );
  assert.match(mod, /topic: PASSKEY_RECORD_TOPIC,\s*data: record,\s*route: await routeFor\(\),\s*knownVersion: 0,/);
  assert.match(mod, /return FEED_ROUTES\.recoveryPortability;/);
  assert.equal(mod.split("await routeFor()").length - 1, 2, "both sides resolve the route the same way");
});

test("the pending record is written once a session exists", () => {
  const mint = store.indexOf("await requestSessionDelegation(parent, signer, expectedSigner)");
  const write = store.indexOf("void _maybeWritePasskeyRecord();", mint);
  assert.ok(mint > 0 && write > mint);
});

test("the record module stays out of the eager bundle", () => {
  assert.doesNotMatch(store, /^\s*import\s[^;]*from\s+["']\.\/passkey-record\.js["']/m);
  assert.match(store, /await import\("\.\/passkey-record\.js"\)/);
});

test("the shared record module is reached by subpath only, never through the package index", () => {
  const index = readFileSync(fileURLToPath(new URL("../../../packages/shared/src/index.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(index, /passkey-record/);
});

test("the login screen shows the steer beside the existing Add this device button, and only once", () => {
  const ui = readFileSync(
    fileURLToPath(new URL("../src/lib/components/auth/PasskeyLogin.svelte", import.meta.url)),
    "utf8",
  );
  assert.match(ui, /\} else if \(res\.otherDevice && onlink\) \{\s*otherDevice = true;\s*error = res\.error\?\.message \?\? null;/);
  const steer = ui.indexOf("{#if otherDevice && error}");
  const button = ui.indexOf('<button class="create-btn" class:emphasised={otherDevice} onclick={onlink}');
  assert.ok(steer > 0 && button > steer, "the message sits right above the button it points at");
  assert.equal(ui.split("onclick={onlink}").length - 1, 1, "no second Add this device button");
  assert.match(ui, /\{#if error && !otherDevice\}/, "the bottom error line does not repeat it");
  assert.match(ui, /error = null;\s*otherDevice = false;/, "a new attempt clears it");
});
