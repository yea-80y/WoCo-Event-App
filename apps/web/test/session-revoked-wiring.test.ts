/**
 * "Sign out everywhere" must reach devices that can sign silently (#186). The
 * server answers a revoked session with SESSION_REVOKED; the client must sign
 * out on it - on every request path - and never mint a replacement session.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const CLIENT = read("../src/lib/api/client.ts");
const STORE = read("../src/lib/auth/auth-store.svelte.ts");
const PROFILE = read("../src/lib/components/profile/ProfilePage.svelte");

test("both request paths sign out on SESSION_REVOKED, before the SESSION_INVALID re-mint", () => {
  const hits = CLIENT.match(/AuthErrorCode\.SESSION_REVOKED\) \{\s*(\/\/[^\n]*\n\s*)*void auth\.onSessionRevoked\(\);\s*return/g);
  assert.equal(hits?.length, 2, "authFetch and authStream");
  for (const marker of ["if (result.code === AuthErrorCode.SESSION_REVOKED)", "if (body?.code === AuthErrorCode.SESSION_REVOKED)"]) {
    const at = CLIENT.indexOf(marker);
    assert.ok(at > 0, marker);
    const reMint = CLIENT.indexOf("SESSION_INVALID", at);
    assert.ok(reMint > at, "the revoked branch returns before the re-mint branch");
  }
});

test("onSessionRevoked signs out fully, once, and says why", () => {
  const start = STORE.indexOf("async function onSessionRevoked(");
  assert.ok(start > 0);
  const body = STORE.slice(start, STORE.indexOf("\n}\n", start));
  assert.match(body, /_signingOutRevoked \|\| _kind === "none"\) return/);
  assert.match(body, /_postAuthNotice\(SESSION_REVOKED_MESSAGE\)/);
  assert.match(body, /await logout\(\{ force: true \}\)/);
});

test("'Sign out everywhere' signs this device out too, only after the server agreed", () => {
  const start = PROFILE.indexOf("async function revokeAllSessions(");
  const body = PROFILE.slice(start, PROFILE.indexOf("\n  }\n", start));
  const ok = body.indexOf("if (!res.ok) throw");
  const out = body.indexOf("await auth.onSessionRevoked()");
  assert.ok(ok > 0 && out > ok);
});
