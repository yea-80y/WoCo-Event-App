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

test("the guard runs on sign-in, after the account is derived and before anything is committed", () => {
  const body = loginBody();
  const kernel = body.indexOf("const kernel = await buildKernelFromPrivateKey(");
  const guard = body.indexOf("await guardPasskeyRecord(account.credentialId, kernel.address)");
  const commit = body.indexOf("await _clearStaleAuthForSwitch(kernel.address);", kernel);
  assert.ok(kernel > 0 && guard > kernel, "the guard needs the derived account address");
  assert.ok(commit > guard, "the guard must refuse before the login clears or writes any state");
  const gate = body.lastIndexOf('if (mode === "signin")', guard);
  assert.ok(gate > kernel && gate < guard, "a passkey created this moment has no record to check");
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
  assert.match(mod, /readContentFeedAtVersion\(address, PASSKEY_RECORD_TOPIC, 0, \{ route: await routeFor\(\) \}\)/);
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
