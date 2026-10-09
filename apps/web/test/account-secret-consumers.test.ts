/**
 * After a passkey is removed the account signs and seals under a NEW secret (#186), so
 * nothing outside the auth store may derive the feed signer or the order key from the
 * raw identity seed: it would sign or seal under keys the removed passkey still holds.
 * Everything goes through `auth.getAccountSecrets()` (current to sign and seal, all to
 * open). The seed itself stays for what never rotates: the issuing key, escrow and
 * portability (inside the store), the out-of-launch credits rail, and the
 * email-to-passkey upgrade (always generation 0).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|svelte)$/.test(name) ? [p] : [];
  });
}

// Code only: a doc comment naming a function is not a call.
const code = (text: string) =>
  text.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
const SOURCES = files(SRC).map((p) => ({ path: relative(SRC, p), text: code(readFileSync(p, "utf8")) }));

function users(pattern: RegExp): string[] {
  return SOURCES.filter((f) => pattern.test(f.text)).map((f) => f.path).sort();
}

test("the raw seed is read only where nothing rotates", () => {
  assert.deepEqual(users(/\bgetIdentitySeed\(\)/), ["lib/auth/issuing-key.ts", "lib/credits/credits.ts"]);
});

test("the feed signer is derived only in the auth store (and the generation-0 upgrade)", () => {
  assert.deepEqual(users(/\bderiveFeedSignerKey\(/), ["lib/auth/auth-store.svelte.ts", "lib/auth/upgrade-to-passkey.ts"]);
});

test("the order key is derived only from the account's secrets", () => {
  const derive = /\bderiveXWingKeypairFromSeed\(([^)]*)\)/g;
  for (const f of SOURCES) {
    for (const m of f.text.matchAll(derive)) {
      assert.match(m[1]!, /^(secrets\.current|s)$/, `${f.path}: deriveXWingKeypairFromSeed(${m[1]})`);
    }
  }
  assert.deepEqual(users(/\bderiveXWingKeypairFromSeed\(/), [
    "lib/api/events.ts",
    "lib/creator/events/PublishButton.svelte",
    "lib/keyring/order-keys.ts",
  ]);
});
