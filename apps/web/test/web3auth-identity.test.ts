/**
 * A returning email/social user is never silently given a different account (#1051):
 * web3auth-identity.ts keys one record per person per device by WHO signed in, and the
 * sign-in refuses a known person whose key moved, before any account is opened.
 *
 * MUTATION: put authConnectionId into the tag, stop lower-casing the user id, let a
 * corrupt record count, drop the refusal or move it after the account build, skip the
 * write after a sign-in, or read identity through the network-bound getUserInfo first,
 * and a case below goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  identityFromUserInfo,
  identityTag,
  keyChanged,
  readIdentityRecord,
  writeIdentityRecord,
  type IdentityStorage,
} from "../src/lib/auth/web3auth-identity.ts";

const PROJECT = { clientId: "client-1", network: "sapphire_mainnet" };
const A = "0x7b15425ea7eb66863b0728b9fe3c8abba2a348c5";
const B = "0x85fab6db2f459331865354eba1c49d50a8a977a4";
const KERNEL = "0xad85506922d0169330360f8407087010d1733bac";

function memory(): IdentityStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

test("who signed in: v11 fields, v10 fields, and nothing when it names no one", () => {
  assert.deepEqual(identityFromUserInfo({ userId: " Sam@Example.com ", authConnection: "email_passwordless", authConnectionId: "w3a-email" }), {
    userId: "Sam@Example.com",
    authConnection: "email_passwordless",
    authConnectionId: "w3a-email",
  });
  assert.deepEqual(identityFromUserInfo({ verifierId: "sam@example.com", typeOfLogin: "google", verifier: "w3a-google" }), {
    userId: "sam@example.com",
    authConnection: "google",
    authConnectionId: "w3a-google",
  });
  assert.equal(identityFromUserInfo({ authConnection: "google" }), null);
  assert.equal(identityFromUserInfo({ userId: "x" }), null);
  assert.equal(identityFromUserInfo(null), null);
});

test("the tag: same person whatever the case, a different one per project, network and login method", async () => {
  const id = { userId: "sam@example.com", authConnection: "email_passwordless" };
  const tag = await identityTag(id, PROJECT);
  assert.match(tag, /^[0-9a-f]{64}$/);
  assert.equal(await identityTag({ ...id, userId: " SAM@Example.com" }, PROJECT), tag);
  assert.notEqual(await identityTag(id, { ...PROJECT, clientId: "client-2" }), tag);
  assert.notEqual(await identityTag(id, { ...PROJECT, network: "sapphire_devnet" }), tag);
  assert.notEqual(await identityTag({ ...id, authConnection: "google" }, PROJECT), tag);
});

test("a renamed connection keeps the SAME tag, so the key it moves is still caught", async () => {
  const id = { userId: "sam@example.com", authConnection: "email_passwordless" };
  assert.equal(await identityTag({ ...id, authConnectionId: "old-name" }, PROJECT), await identityTag({ ...id, authConnectionId: "new-name" }, PROJECT));
});

test("records: round trip, no raw email stored, corrupt or foreign reads as absent", async () => {
  const store = memory();
  const identity = { userId: "sam@example.com", authConnection: "email_passwordless", authConnectionId: "w3a-email" };
  const tag = await identityTag(identity, PROJECT);
  assert.equal(readIdentityRecord(tag, store), null);
  writeIdentityRecord(tag, { eoa: A.toUpperCase().replace("0X", "0x"), kernel: KERNEL, identity }, store, 1000);
  assert.deepEqual(readIdentityRecord(tag, store), { eoa: A, kernel: KERNEL, authConnection: "email_passwordless", authConnectionId: "w3a-email", at: 1000 });
  assert.ok(![...store.data.keys(), ...store.data.values()].some((s) => s.includes("sam@example.com")), "no raw email in storage");

  store.data.set(`woco:w3aid:${tag}`, "{not json");
  assert.equal(readIdentityRecord(tag, store), null);
  store.data.set(`woco:w3aid:${tag}`, JSON.stringify({ eoa: "nope", kernel: KERNEL, authConnection: "x" }));
  assert.equal(readIdentityRecord(tag, store), null);
  assert.equal(readIdentityRecord("not-a-tag", store), null);
});

test("refuse only a KNOWN person with a DIFFERENT key", () => {
  const known = { eoa: A, kernel: KERNEL, authConnection: "email_passwordless", at: 0 };
  assert.equal(keyChanged(null, B), false, "first sign-in on this device");
  assert.equal(keyChanged(known, A.toUpperCase().replace("0X", "0x")), false, "same key, any case");
  assert.equal(keyChanged(known, B), true);
});

const STORE = readFileSync(new URL("../src/lib/auth/auth-store.svelte.ts", import.meta.url), "utf8");
const ADAPTER = readFileSync(new URL("../src/lib/auth/web3auth-sdk-adapter.ts", import.meta.url), "utf8");

test("sign-in: the check runs after the fast path and before any account is built or stored", () => {
  const body = STORE.slice(STORE.indexOf("async function _runWeb3AuthSignIn("), STORE.indexOf("function cancelLogin(): void"));
  const fastReturn = body.indexOf("_recordEmailIdentityIfAbsent(address, cachedKernel);");
  const check = body.indexOf('step = "identity";');
  const refuse = body.indexOf("if (keyChanged(known, address)) throw await _refuseChangedEmailKey(");
  const build = body.indexOf("await buildKernelFromPrivateKey(");
  const firstWrite = body.indexOf("await _clearStaleAuthForSwitch(kernel.address);");
  const record = body.indexOf("if (who) writeIdentityRecord(who.tag, { eoa: address, kernel: kernel.address, identity: who.identity });");
  assert.ok(fastReturn > 0 && check > fastReturn, "the fast path (this key opened an account here) is not checked");
  assert.ok(refuse > check && refuse < build && build < firstWrite, "refused before the build and before anything is written");
  assert.ok(record > firstWrite, "the reference is written once the account resolved");
  assert.match(body, /if \(!fastOverride\) \{\s*if \(!who\) throw new Error\(/, "an unreadable identity never passes as a first sign-in");
});

test("refusal: ends the Web3Auth session and reaches the person as itself", () => {
  const fn = STORE.slice(STORE.indexOf("async function _refuseChangedEmailKey("), STORE.indexOf("async function _refuseUpgradedEmailLogin("));
  assert.match(fn, /await logoutWeb3Auth\(\);/);
  assert.match(fn, /postOrphanedCredentialNotice\("web3auth", undefined, KEY_CHANGED_MESSAGE\);/);
  assert.match(fn, /return new OrphanedCredentialError\("web3auth", known\.kernel, KEY_CHANGED_MESSAGE\);/);
  assert.match(STORE, /if \(isOrphanedCredentialError\(e\) \|\| isWeb3AuthSignInError\(e\)\) throw e;/, "the catch passes it through untouched");
});

test("identity is read from the session first, not the network-bound getUserInfo", () => {
  const fn = ADAPTER.slice(ADAPTER.indexOf("userIdentityInfo: async () => {"), ADAPTER.indexOf("on: (event, fn)"));
  const local = fn.indexOf("auth?.getUserInfo?.()");
  const network = fn.indexOf("return sdk.getUserInfo();");
  assert.ok(local > 0 && network > local, "authInstance first, the connector's getUserInfo last");
});
