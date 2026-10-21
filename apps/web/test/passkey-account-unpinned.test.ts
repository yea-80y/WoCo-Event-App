/**
 * The mint/pin split in passkey-account.ts (#158).
 *
 * Recovery has to create the passkey BEFORE the irreversible on-chain rotation,
 * because the new Kernel owner is that credential's PRF-EOA — and must not make
 * it this device's login until the rotation is proven. Those are two different
 * moments, so they are two different functions, and what makes the split real is
 * that the minting half touches NO storage. A future edit that "helpfully" writes
 * the credential inside the mint re-creates #158 while every ordering assertion in
 * recovery-credential-pin-order.test.ts stays green, so the write is asserted here
 * against a real IndexedDB round-trip rather than against the source text.
 *
 * Runs the REAL passkey-account code against a scripted passkey window
 * (fake-passkey-window.ts): the window's answer, the owner-key address and the pin
 * are real; only the window and IndexedDB are stand-ins.
 *
 * MUTATION: add `await putKV(StorageKeys.PASSKEY_CREDENTIAL, credential)` inside
 * `_mintPasskeyAccountImpl`, and the first test goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { StorageKeys } from "@woco/shared";
import { SAMSUNG_AAGUID, accountResult, installFakeIndexedDB, scriptedWindow } from "./fake-passkey-window.ts";

const RAW_ID_B64URL = "AQIDBAUGBwgJCgsMDQ4PEA";
const RP_ID = "auth.woco.eth.limo";

installFakeIndexedDB();
const win = scriptedWindow();
const creation = () => accountResult({ credentialId: RAW_ID_B64URL, aaguid: SAMSUNG_AAGUID });

const { createPasskeyAccount, createPasskeyAccountUnpinned, pinPasskeyCredential, __setPasskeyWindowForTests } =
  await import("../src/lib/auth/passkey-account.ts");
const { getKV, delKV } = await import("../src/lib/auth/storage/indexeddb.ts");
__setPasskeyWindowForTests(win.run);

test("createPasskeyAccountUnpinned mints without pinning, and the handle pins exactly what it minted", async () => {
  await delKV(StorageKeys.PASSKEY_CREDENTIAL);
  win.answer(creation());
  const before = win.requests.length;

  const fresh = await createPasskeyAccountUnpinned();

  assert.deepEqual(win.requests.slice(before).map((r) => r.action), ["create"], "the ceremony must actually have run");
  assert.equal(
    await getKV(StorageKeys.PASSKEY_CREDENTIAL),
    null,
    "createPasskeyAccountUnpinned must write NOTHING — the pin is the caller's commit (#158)",
  );
  assert.deepEqual(
    fresh.credential,
    { credentialId: RAW_ID_B64URL, rpId: RP_ID, provider: "samsung-pass" },
    "the handle must carry the minted credential id and RP ID, so the caller can pin it later",
  );
  assert.match(fresh.address, /^0x[0-9a-f]{40}$/, "the PRF-EOA address is what becomes the new Kernel owner");
  assert.match(fresh.privateKey, /^0x[0-9a-f]{64}$/);

  await pinPasskeyCredential(fresh.credential);
  assert.deepEqual(
    await getKV(StorageKeys.PASSKEY_CREDENTIAL),
    { credentialId: RAW_ID_B64URL, rpId: RP_ID, provider: "samsung-pass" },
    "pinPasskeyCredential must store the handle it was given, unchanged",
  );
});

test("createPasskeyAccount still pins at mint time", async () => {
  // The create-an-account login path depends on it: there is no later commit to
  // hang the pin on, so splitting recovery must not have changed this caller.
  await delKV(StorageKeys.PASSKEY_CREDENTIAL);
  win.answer(creation());

  const account = await createPasskeyAccount();

  assert.deepEqual(
    await getKV(StorageKeys.PASSKEY_CREDENTIAL),
    { credentialId: RAW_ID_B64URL, rpId: RP_ID, provider: "samsung-pass" },
    "createPasskeyAccount must keep writing the pin itself",
  );
  assert.match(account.address, /^0x[0-9a-f]{40}$/);
  assert.equal(
    (account as { credential?: unknown }).credential,
    undefined,
    "its return shape is unchanged — the handle is the unpinned variant's affordance",
  );
});

test("both halves derive the SAME key from the same credential", async () => {
  // The split must be a split and nothing more: if the two paths ever derived
  // differently, recovery would rotate the account to an owner that this device's
  // own login could not reproduce.
  await delKV(StorageKeys.PASSKEY_CREDENTIAL);
  win.answer(creation(), creation());
  const unpinned = await createPasskeyAccountUnpinned();
  const pinned = await createPasskeyAccount();
  assert.equal(unpinned.address, pinned.address);
  assert.equal(unpinned.privateKey, pinned.privateKey);
});
