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

test("a record is queued only from a creation, and only for an on-device passkey", () => {
  const body = loginBody();
  const queue = body.indexOf("_setPendingPasskeyRecord(");
  const policy = body.indexOf("mayWriteRecordAtCreation(account.attachment)");
  const gate = body.lastIndexOf('if (mode === "create")', queue);
  assert.ok(policy > 0 && queue > policy && gate > 0 && gate < policy);
  assert.equal(body.split("_setPendingPasskeyRecord(").length - 1, 1, "no other login path may queue a record");
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
