/**
 * Where passkeys live (auth/passkey-rp.ts). FROZEN from launch: a different RP ID is a
 * different account for every passkey user.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as rp from "../../src/auth/passkey-rp.js";

test("FROZEN: passkeys live on auth.woco.eth.limo, a sibling of every sub-name", () => {
  assert.equal(rp.PASSKEY_PRODUCTION_RP_ID, "auth.woco.eth.limo");
  assert.equal(rp.PASSKEY_WINDOW_ORIGIN, "https://auth.woco.eth.limo");
  assert.equal(rp.WOCO_APP_ORIGIN, "https://woco.eth.limo");
});

test("the RP ID is the window's own host, and the app is not on it", () => {
  assert.equal(new URL(rp.PASSKEY_WINDOW_ORIGIN).hostname, rp.PASSKEY_PRODUCTION_RP_ID);
  assert.notEqual(new URL(rp.WOCO_APP_ORIGIN).hostname, rp.PASSKEY_PRODUCTION_RP_ID);
});

test("dev is two localhost origins: the same RP ID, two origins, as production has two", () => {
  assert.equal(new URL(rp.PASSKEY_DEV_APP_ORIGIN).hostname, "localhost");
  assert.equal(new URL(rp.PASSKEY_DEV_WINDOW_ORIGIN).hostname, "localhost");
  assert.notEqual(rp.PASSKEY_DEV_APP_ORIGIN, rp.PASSKEY_DEV_WINDOW_ORIGIN);
});

test("no RP-ID resolver is left to widen: the app never asks for one", () => {
  assert.deepEqual(Object.keys(rp).sort(), [
    "PASSKEY_DEV_APP_ORIGIN", "PASSKEY_DEV_WINDOW_ORIGIN", "PASSKEY_PRODUCTION_RP_ID", "PASSKEY_WINDOW_ORIGIN", "WOCO_APP_ORIGIN",
  ]);
});
