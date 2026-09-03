/**
 * The scoped ZeroDev session key may call exactly ONE function on ONE contract.
 *
 * Why this is pinned rather than left to review: the key lives on a device for
 * 30 days and signs without a prompt. `registerWithPermit` is safe to sign
 * silently — it mints a name to the holder, and the server's permit is required
 * anyway. `release` is not: it BURNS a name irreversibly. A key scoped to reach
 * it would mean a stolen or exfiltrated device could destroy every name the
 * holder owns, silently, with no gesture from the user.
 *
 * So the release rails are deliberately the ones that COST a gesture — a sudo
 * userOp (passkey prompt) or the wallet's own confirmation — and this test
 * fails if anything is ever added to the session key's call policy.
 *
 * A source-level test on purpose: the policy is built inside a function that
 * dynamically imports the whole ZeroDev SDK, so asserting on the built object
 * would need the SDK, a bundler and a network. What actually regresses here is
 * someone adding a permission, and that is visible in the source.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/lib/auth/kernel-account.ts", import.meta.url), "utf-8");

/** The session-key policy block, comments stripped. */
function sessionKeyPolicy(): string {
  const start = SRC.indexOf("export async function createWocoSessionKey");
  assert.ok(start > 0, "createWocoSessionKey not found");
  const end = SRC.indexOf("export async function", start + 10);
  const block = SRC.slice(start, end > 0 ? end : undefined);
  return block
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
}

test("the WoCo session key is scoped to registerWithPermit and nothing else", () => {
  const policy = sessionKeyPolicy();
  const fns = [...policy.matchAll(/functionName:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(fns, ["registerWithPermit"], `session key may call only registerWithPermit, found: ${fns.join(", ")}`);
});

test("the session key cannot reach release, in any form", () => {
  const policy = sessionKeyPolicy();
  // `release` and `releaseWithSignature` both burn. Neither may ever appear in
  // this key's permissions — a burn must not be silently signable.
  assert.doesNotMatch(policy, /release/i, "the session key policy must never mention a release");
});

test("the session key targets only the registrar, never the registry", () => {
  const policy = sessionKeyPolicy();
  const targets = [...policy.matchAll(/target:\s*([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
  assert.deepEqual(targets, ["WOCO_REGISTRAR_ADDRESS"]);
  // The registry is where release lives, so the key must not be aimed at it
  // even for a read-shaped call.
  assert.doesNotMatch(policy, /WOCO_REGISTRY_ADDRESS/);
});

test("the release client never routes through the session key", () => {
  const release = readFileSync(new URL("../src/lib/sub-ens/release.ts", import.meta.url), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
  // The two session-key entry points. `sendSudoUserOp` (a passkey prompt) and a
  // wallet transaction are the sanctioned rails; the scoped key is not.
  assert.doesNotMatch(release, /sendSessionUserOp|ensureWocoSessionKey/);
});
