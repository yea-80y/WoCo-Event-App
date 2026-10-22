/**
 * The sign-in sheet's device hint (sign-in-hint.ts, owner + Fable 10-22): which of its
 * three layouts a sheet opens on, from the passkey pin and the last way in - and that the
 * last way in is written ONCE, at sign-out, from the committed kind, and read by the sheet
 * only.
 *
 * MUTATIONS (each turns this file red): count a pin under another RP ID as a passkey here;
 * let "email" win on an organiser sheet; record a way in for a wallet or Coinbase account;
 * move the write before the identity keys or after `_kind` resets; delete the record at
 * sign-out; read it anywhere but sign-in-hint.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sheetState, signInHint, wayInOf } from "../src/lib/auth/sign-in-hint.js";

const RP = "auth.woco.eth.limo";

test("a passkey is 'here' only when pinned under the window's RP ID", () => {
  assert.equal(signInHint({ rpId: RP }, null, RP).passkeyHere, true);
  assert.equal(signInHint({ rpId: "woco.eth.limo" }, null, RP).passkeyHere, false, "a pin from before the window never opens");
  assert.equal(signInHint(null, null, RP).passkeyHere, false);
  assert.equal(signInHint({}, null, RP).passkeyHere, false);
});

test("the last way in is 'passkey', 'email' or nothing", () => {
  assert.equal(signInHint(null, "passkey", RP).last, "passkey");
  assert.equal(signInHint(null, "email", RP).last, "email");
  for (const junk of ["web3auth", "", 1, {}, undefined, null]) assert.equal(signInHint(null, junk, RP).last, null, String(junk));
});

test("three layouts: known, email, new", () => {
  const h = (passkeyHere: boolean, last: "passkey" | "email" | null) => ({ passkeyHere, last });
  assert.equal(sheetState(h(true, "passkey"), false), "known");
  assert.equal(sheetState(h(true, null), false), "known", "a pin made before the record existed");
  assert.equal(sheetState(h(true, "email"), false), "email", "email used since the passkey: email is what they reach for");
  assert.equal(sheetState(h(false, "email"), false), "email");
  assert.equal(sheetState(h(false, "passkey"), false), "new", "a passkey that cannot open here is no help");
  assert.equal(sheetState(h(false, null), false), "new");
  // An organiser sheet offers no email.
  assert.equal(sheetState(h(true, "email"), true), "known");
  assert.equal(sheetState(h(false, "email"), true), "new");
});

test("only the two ways in the sheet offers are recorded", () => {
  assert.equal(wayInOf("passkey"), "passkey");
  assert.equal(wayInOf("web3auth"), "email");
  for (const kind of ["web3", "coinbase", "zupass", "none", null] as const) assert.equal(wayInOf(kind), null, String(kind));
});

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

test("written once, at sign-out: after the identity keys, before the kind resets, never deleted", () => {
  const store = read("../src/lib/auth/auth-store.svelte.ts");
  const start = store.indexOf("async function clearAllAuth(): Promise<void> {");
  const body = store.slice(start, store.indexOf("\n}\n", start));
  const keys = body.indexOf('await step("identity-keys"');
  const write = body.indexOf('await step("last-way-in", () => putKV(StorageKeys.LAST_WAY_IN, wayIn));');
  const kind = body.indexOf("const wayIn = wayInOf(_kind);");
  const reset = body.indexOf('_kind = "none";');
  assert.ok(start > 0 && keys > 0 && kind > keys && write > kind && reset > write, "identity keys, then the kind read, then the write, then the reset");
  assert.equal(store.split("StorageKeys.LAST_WAY_IN").length - 1, 1, "the store's only mention is that write");
  assert.ok(!/delKV\(StorageKeys\.LAST_WAY_IN/.test(store));
});

test("the sheet's hint is the only reader", () => {
  const src = fileURLToPath(new URL("../src", import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|svelte)$/.test(name)) files.push(path);
    }
  };
  walk(src);
  const users = files.filter((f) => readFileSync(f, "utf8").includes("LAST_WAY_IN")).map((f) => f.slice(src.length + 1)).sort();
  assert.deepEqual(users, ["lib/auth/auth-store.svelte.ts", "lib/auth/sign-in-hint.ts"]);
});
