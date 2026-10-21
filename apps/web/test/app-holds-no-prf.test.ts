/**
 * The app never runs a passkey ceremony and never holds the PRF output: both live in
 * the passkey sign-in window (src/auth-window/). This walks every app source file -
 * the window's own excepted - so the property is one a reviewer can rely on, not one a
 * refactor can quietly undo (Fable 10-21: "a source-graph property, strictly stronger
 * than a build-config one").
 *
 * MUTATIONS: call `navigator.credentials.get` anywhere in src/lib, import
 * `passkeyIdentitySeed` (or any PRF-taking derivation) there, or move the
 * `primePasskeyWindow()` call below the first await in PasskeyLogin - each turns this red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|svelte)$/.test(name)) out.push(p);
  }
  return out;
}

const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1").replace(/<!--[\s\S]*?-->/g, "");

const APP = walk(SRC)
  .map((p) => ({ rel: relative(SRC, p), code: stripComments(readFileSync(p, "utf8")) }))
  .filter((f) => !f.rel.startsWith("auth-window/"));

/** Every derivation that takes the PRF output itself (`@woco/shared` crypto/passkey-prf.ts). */
const PRF_TAKING = [
  "passkeyPrfBytes",
  "passkeyIdentitySeed",
  "passkeySeedKek",
  "portabilitySocOwnerKey",
  "portabilitySocOwnerPrivateKey",
  "portabilityHpkeSeed",
  "passkeyBoxSeed",
  "passkeyBoxKeypair",
  "passkeyGuardianEscrowMaster",
  "passkeyOwnerKey",
  "passkeyAccountKeys",
  "passkeyGuardianKeys",
];

test("the scan sees the app: it is not vacuous", () => {
  assert.ok(APP.length > 300, `only ${APP.length} files`);
  assert.ok(APP.some((f) => f.rel === "lib/auth/passkey-account.ts"));
  assert.ok(!APP.some((f) => f.rel.startsWith("auth-window/")));
});

test("no app file runs a WebAuthn ceremony", () => {
  const offenders = APP.filter((f) => /\bcredentials\s*\.\s*(get|create)\s*\(|\bPublicKeyCredential\s*\.\s*(parseCreationOptionsFromJSON|parseRequestOptionsFromJSON)/.test(f.code));
  assert.deepEqual(offenders.map((f) => f.rel), []);
});

test("no app file derives anything from a PRF output, or knows the PRF salt", () => {
  const re = new RegExp(`\\b(${PRF_TAKING.join("|")})\\s*\\(|PASSKEY_PRF_SALT_INPUT|woco-passkey-secp256k1-v1`);
  const offenders = APP.filter((f) => re.test(f.code));
  assert.deepEqual(offenders.map((f) => `${f.rel}: ${re.exec(f.code)![0]}`), []);
});

test("the sign-in button opens the window before anything else it does", () => {
  const button = APP.find((f) => f.rel === "lib/components/auth/PasskeyLogin.svelte")!.code;
  const run = button.slice(button.indexOf('async function run(mode: "signin" | "create") {'));
  const firstStatement = run.slice(run.indexOf("{") + 1).trim().split("\n")[0]!.trim();
  assert.equal(firstStatement, "primePasskeyWindow();");
});
