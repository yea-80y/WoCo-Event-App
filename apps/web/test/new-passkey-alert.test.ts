/** The new-passkey alert's diff and wiring (#746, Fable consult 9 Q5). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { newSince } from "../src/lib/auth/new-passkey-alert.js";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

test("only keys that were not there before, never this device's own", () => {
  assert.deepEqual(newSince([a(1)], [a(1), a(2)], a(1)), [a(2)]);
  assert.deepEqual(newSince([a(1), a(2)], [a(1)], a(1)), [], "a removal is not news");
  assert.deepEqual(newSince([a(1)], [a(1), a(3)], a(3)), [], "the passkey signed in here is never news");
  assert.deepEqual(newSince([a(1).toUpperCase().replace("0X", "0x")], [a(1)], a(9)), [], "case-insensitive");
});

test("a first look is remembered silently; additions wait for an answer; own additions are remembered", () => {
  const src = readFileSync(new URL("../src/lib/auth/new-passkey-alert.ts", import.meta.url), "utf8");
  assert.match(src, /if \(seen === null\) \{\s*writeSeen\(parent, now\);\s*return \[\];/);
  assert.match(src, /if \(added\.length === 0\) writeSeen\(parent, now\);/);
  const flows = readFileSync(new URL("../src/lib/auth/co-owner-flows.ts", import.meta.url), "utf8");
  assert.match(flows, /if \(added && parent\) \{[\s\S]{0,200}rememberOwnPasskey\(parent, key\)/);
});

test("mounted in both shells, only for a passkey account with a session, loaded lazily", () => {
  for (const shell of ["../src/lib/layouts/AttendeeShell.svelte", "../src/lib/layouts/CreatorShell.svelte"]) {
    const src = readFileSync(new URL(shell, import.meta.url), "utf8");
    assert.match(src, /\{#if auth\.kind === "passkey" && auth\.hasSession\}\s*\{#await import\("\.\.\/components\/passkeys\/NewPasskeyBanner\.svelte"\)/);
    assert.doesNotMatch(src, /import NewPasskeyBanner from/);
  }
});
