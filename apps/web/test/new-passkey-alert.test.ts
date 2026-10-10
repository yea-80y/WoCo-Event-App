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

test("acknowledging remembers exactly the passkeys shown - never a fresh read (no check-then-act gap)", async () => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const { acknowledgePasskeys } = await import("../src/lib/auth/new-passkey-alert.js");
  const parent = a(9);
  store.set(`woco:passkeys:seen:${parent}`, JSON.stringify([a(1)]));
  acknowledgePasskeys(parent, [a(2)]);
  assert.deepEqual(JSON.parse(store.get(`woco:passkeys:seen:${parent}`)!), [a(1), a(2)]);
  const src = readFileSync(new URL("../src/lib/auth/new-passkey-alert.ts", import.meta.url), "utf8");
  const ack = src.slice(src.indexOf("export function acknowledgePasskeys("));
  assert.doesNotMatch(ack.slice(0, ack.indexOf("\n}\n")), /readCoOwners/);
});
