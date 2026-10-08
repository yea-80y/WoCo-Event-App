/**
 * Session revocation store (#186): a present-but-unreadable file is never
 * written over, refuses new revocations, and shows on /api/health. Before this,
 * any read or parse error loaded as an empty store and the next revoke replaced
 * the file, silently un-revoking every session in it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "woco-revocation-"));
const originalCwd = process.cwd();
process.chdir(dir);
mkdirSync(join(dir, ".data"));
after(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

const FILE = join(dir, ".data", "revoked-sessions.json");
const rev = await import("../src/lib/auth/revocation.js");

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const PARENT = "0x" + "ab".repeat(20);

function fresh(contents: string | null): void {
  rmSync(FILE, { force: true });
  if (contents !== null) writeFileSync(FILE, contents);
  rev.__resetRevocationForTest();
}

for (const [label, contents] of [
  ["not JSON", "{ truncated"],
  ["JSON of the wrong shape", JSON.stringify({ version: 1, nonces: [] })],
  ["a file with a malformed entry", JSON.stringify({ version: 1, nonces: ["abc"], revokeAllBefore: {} })],
] as const) {
  test(`a ${label} file is never overwritten, and nothing can be revoked until it is restored`, () => {
    fresh(contents);
    assert.equal(rev.isSessionRevoked("n1", PARENT, new Date().toISOString()), false, "reads stay open");
    assert.deepEqual(rev.revocationHealth(), { ok: false });
    assert.throws(() => rev.revokeSession("n1", FUTURE), rev.RevocationStoreUnavailableError);
    assert.throws(() => rev.revokeAllSessions(PARENT), rev.RevocationStoreUnavailableError);
    assert.equal(readFileSync(FILE, "utf-8"), contents, "the operator's copy is untouched");
  });
}

test("a readable file loads, refuses its nonces, and takes new revocations", () => {
  fresh(JSON.stringify({ version: 1, nonces: [{ nonce: "old", expiresAt: FUTURE }], revokeAllBefore: {} }));
  assert.equal(rev.isSessionRevoked("old", PARENT, new Date().toISOString()), true);
  assert.deepEqual(rev.revocationHealth(), { ok: true });
  rev.revokeSession("new", FUTURE);
  rev.__resetRevocationForTest();
  assert.equal(rev.isSessionRevoked("new", PARENT, new Date().toISOString()), true, "persisted across a reload");
});

test("a missing file is a fresh store, not an alarm", () => {
  fresh(null);
  assert.deepEqual(rev.revocationHealth(), { ok: true });
  rev.revokeAllSessions(PARENT);
  assert.equal(rev.isSessionRevoked("any", PARENT, new Date(Date.now() - 1000).toISOString()), true);
});
