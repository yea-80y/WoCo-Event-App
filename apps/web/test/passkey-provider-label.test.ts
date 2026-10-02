/**
 * The password manager that holds a passkey (#746) is recorded with the credential
 * on THIS device, for the passkeys list - and nowhere else. Which manager holds an
 * account's keys tells someone which account to attack, so it never goes to the
 * server: the ratchet below fails the build if any API or server module starts
 * handling it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const ACCOUNT = read("../src/lib/auth/passkey-account.ts");

test("a new passkey's record carries the manager that made it", () => {
  assert.match(ACCOUNT, /rpId,\s*provider: providerOf\(credential\),\s*\};/);
});

test("a sign-in keeps the label recorded for the same passkey instead of erasing it", () => {
  assert.match(
    ACCOUNT,
    /\.\.\.\(prev\?\.credentialId === credentialId && prev\.provider \? \{ provider: prev\.provider \} : \{\}\)/,
  );
});

test("reading the label can never fail a sign-up", () => {
  const start = ACCOUNT.indexOf("function providerOf(");
  const body = ACCOUNT.slice(start, ACCOUNT.indexOf("\n}\n", start));
  assert.match(body, /try \{[\s\S]*\} catch \{\s*return "unknown";\s*\}/);
});

function sources(dir: string): { rel: string; code: string }[] {
  const out: { rel: string; code: string }[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|svelte)$/.test(name)) out.push({ rel: p, code: readFileSync(p, "utf8") });
    }
  };
  walk(dir);
  return out;
}

test("the label never leaves the device: no API or server module handles it", () => {
  const roots = [
    fileURLToPath(new URL("../src/lib/api", import.meta.url)),
    fileURLToPath(new URL("../../server/src", import.meta.url)),
  ];
  const offenders = roots
    .flatMap(sources)
    .filter((f) => /PasskeyProviderId|passkeyProviderFromAaguid|aaguidFromAuthenticatorData|\.provider\b.*passkey/i.test(f.code))
    .map((f) => f.rel);
  assert.deepEqual(offenders, []);
});
