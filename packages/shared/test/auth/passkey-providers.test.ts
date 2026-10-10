import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aaguidFromAuthenticatorData,
  isPasskeyProviderId,
  passkeyProviderFromAaguid,
  PASSKEY_PROVIDER_IDS,
  PASSKEY_PROVIDERS,
} from "../../src/auth/passkey-providers.js";

/** Authenticator data: rpIdHash (32) | flags | signCount (4) | aaguid (16) | the rest. */
function authData(flags: number, aaguidHex: string, extra = 8): Uint8Array {
  const out = new Uint8Array(53 + extra);
  out[32] = flags;
  out.set(Uint8Array.from(Buffer.from(aaguidHex.replace(/-/g, ""), "hex")), 37);
  return out;
}

const SAMSUNG = "53414d53-554e-4700-0000-000000000000";
const GPM = "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4";

test("the AAGUID is read from bytes 37..52 when the attested-credential flag is set", () => {
  assert.equal(aaguidFromAuthenticatorData(authData(0x45, SAMSUNG)), SAMSUNG);
  assert.equal(aaguidFromAuthenticatorData(authData(0x45, GPM)), GPM);
});

test("no flag, too short, or all zero reads as no AAGUID", () => {
  assert.equal(aaguidFromAuthenticatorData(authData(0x05, GPM)), null, "AT flag unset");
  assert.equal(aaguidFromAuthenticatorData(authData(0x45, GPM).subarray(0, 52)), null, "truncated");
  assert.equal(aaguidFromAuthenticatorData(authData(0x45, "00".repeat(16))), null, "all zero");
});

test("known AAGUIDs name their manager; anything else is other; nothing is unknown", () => {
  assert.equal(passkeyProviderFromAaguid(SAMSUNG), "samsung-pass");
  assert.equal(passkeyProviderFromAaguid(GPM.toUpperCase()), "google-password-manager");
  assert.equal(passkeyProviderFromAaguid("11111111-2222-3333-4444-555555555555"), "other");
  assert.equal(passkeyProviderFromAaguid(null), "unknown");
});

test("the id list is closed: every manager plus other and unknown, and nothing else validates", () => {
  assert.deepEqual([...PASSKEY_PROVIDER_IDS].sort(), [...Object.keys(PASSKEY_PROVIDERS), "other", "unknown"].sort());
  for (const id of PASSKEY_PROVIDER_IDS) assert.ok(isPasskeyProviderId(id));
  for (const bad of ["Samsung Pass", "", "constructor", 1, null]) assert.equal(isPasskeyProviderId(bad), false);
});

test("no AAGUID is claimed by two managers", () => {
  const all = Object.values(PASSKEY_PROVIDERS).flatMap((p) => p.aaguids);
  assert.equal(new Set(all).size, all.length);
});
