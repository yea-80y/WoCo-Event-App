/**
 * The passkey window's messages (auth/passkey-window-protocol.ts): what each side
 * accepts. The guarantee they serve: account keys leave the window only for the one
 * request the page that opened it sent, from the allowed origin, once.
 *
 * MUTATIONS (each turns this file red):
 *  - drop `source === opener` -> "a message from any other window is ignored";
 *  - drop the origin check, or match by prefix -> "only the exact allowed origin";
 *  - forget `accepted` -> "a second request is ignored";
 *  - drop the request window -> "a request after a minute is ignored";
 *  - accept another version or an extra field -> "unknown versions and fields are refused, readably";
 *  - drop a per-action field check -> the restore / add tests;
 *  - app side: drop `source === win`, the origin or the nonce check -> "the app hears only its window";
 *  - let a key of the wrong length or type through -> "keys are 32-byte arrays, exactly the set".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PASSKEY_WINDOW_REQUEST_MS,
  acceptPasskeyWindowReply,
  acceptPasskeyWindowRequest,
  newPasskeyWindowNonce,
  parsePasskeyWindowRequest,
} from "../../src/auth/passkey-window-protocol.js";

const APP = "https://woco.eth.limo";
const WINDOW = "https://auth.woco.eth.limo";
const opener = { name: "the app" };
const nonce = newPasskeyWindowNonce();
const ctx = (over: Partial<Parameters<typeof acceptPasskeyWindowRequest>[1]> = {}) => ({
  opener,
  allowedOrigins: [APP],
  accepted: false,
  loadedAt: 1_000,
  now: 2_000,
  ...over,
});
const req = (data: Record<string, unknown> = {}) => ({ origin: APP, source: opener, data: { v: 1, type: "request", nonce, action: "signin", ...data } });

test("the nonce is 16 random bytes, base64url", () => {
  assert.match(nonce, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(newPasskeyWindowNonce(), nonce);
});

test("the opener's request from the allowed origin is accepted", () => {
  assert.deepEqual(acceptPasskeyWindowRequest(req(), ctx()), { v: 1, type: "request", nonce, action: "signin" });
});

test("a message from any other window is ignored, a frame of the opener included", () => {
  assert.equal(acceptPasskeyWindowRequest({ ...req(), source: { name: "a frame inside the app" } }, ctx()), null);
  assert.equal(acceptPasskeyWindowRequest(req(), ctx({ opener: null })), null);
  assert.equal(acceptPasskeyWindowRequest({ ...req(), source: null }, ctx({ opener: null })), null);
});

test("only the exact allowed origin", () => {
  for (const origin of ["https://evil.woco.eth.limo", "https://woco.eth.limo.evil", "http://woco.eth.limo", "https://gateway.woco-net.com", "null", APP + "/"]) {
    assert.equal(acceptPasskeyWindowRequest({ ...req(), origin }, ctx()), null, origin);
  }
});

test("a second request is ignored", () => {
  assert.equal(acceptPasskeyWindowRequest(req(), ctx({ accepted: true })), null);
});

test("a request after a minute is ignored", () => {
  assert.notEqual(acceptPasskeyWindowRequest(req(), ctx({ now: 1_000 + PASSKEY_WINDOW_REQUEST_MS })), null);
  assert.equal(acceptPasskeyWindowRequest(req(), ctx({ now: 1_001 + PASSKEY_WINDOW_REQUEST_MS })), null);
});

test("unknown versions and fields are refused, readably, with the nonce to answer", () => {
  assert.deepEqual(acceptPasskeyWindowRequest(req({ v: 2 }), ctx()), { refused: "version 2", nonce });
  assert.deepEqual(acceptPasskeyWindowRequest(req({ action: "sign" }), ctx()), { refused: "action", nonce });
  assert.deepEqual(acceptPasskeyWindowRequest(req({ scope: "app" }), ctx()), { refused: "fields", nonce });
  assert.deepEqual(acceptPasskeyWindowRequest(req({ nonce: "short" }), ctx()), { refused: "nonce", nonce: null });
  assert.deepEqual(acceptPasskeyWindowRequest({ ...req(), data: "hello" }, ctx()), { refused: "not a request", nonce: null });
});

test("restore needs a credential and a fallback choice, and nothing else", () => {
  const id = "A".repeat(43);
  assert.deepEqual(parsePasskeyWindowRequest(req({ action: "restore", credentialId: id, fallback: true }).data), {
    v: 1, type: "request", nonce, action: "restore", credentialId: id, fallback: true,
  });
  assert.deepEqual(parsePasskeyWindowRequest(req({ action: "restore", credentialId: id }).data), { refused: "fallback" });
  assert.deepEqual(parsePasskeyWindowRequest(req({ action: "restore", credentialId: "a+b/c=", fallback: false }).data), { refused: "credentialId" });
  assert.deepEqual(parsePasskeyWindowRequest(req({ action: "signin", credentialId: id }).data), { refused: "fields" });
});

test("add takes at most 32 excluded credentials and a plain date", () => {
  const id = "B".repeat(43);
  assert.deepEqual(parsePasskeyWindowRequest(req({ action: "add", exclude: [id], createdOn: "21 Oct 2026" }).data), {
    v: 1, type: "request", nonce, action: "add", exclude: [id], createdOn: "21 Oct 2026",
  });
  assert.deepEqual(parsePasskeyWindowRequest(req({ action: "add", exclude: Array(33).fill(id), createdOn: "x" }).data), { refused: "exclude" });
  for (const createdOn of ["", "<b>x</b>", "a\u0000b", "x".repeat(41), "a\nb"]) {
    assert.deepEqual(parsePasskeyWindowRequest(req({ action: "add", exclude: [], createdOn }).data), { refused: "createdOn" }, JSON.stringify(createdOn));
  }
});

const key = () => new Uint8Array(32).fill(7);
const accountKeys = () => ({ ownerKey: key(), seed: key(), seedKek: key(), boxSeed: key(), portabilitySocKey: key(), portabilityHpkeSeed: key() });
const accountResult = () => ({ credentialId: "C".repeat(43), attachment: "platform", handleKind: null, aaguid: null, keys: accountKeys() });
const win = { name: "the window" };
const reply = (data: unknown) => ({ origin: WINDOW, source: win, data });
const appCtx = { win, windowOrigin: WINDOW, nonce, action: "signin" as const };

test("the app hears only its window, at its origin, for its nonce", () => {
  assert.deepEqual(acceptPasskeyWindowReply(reply({ v: 1, type: "ready" }), appCtx), { kind: "ready" });
  assert.equal(acceptPasskeyWindowReply({ ...reply({ v: 1, type: "ready" }), source: {} }, appCtx), null);
  assert.equal(acceptPasskeyWindowReply({ ...reply({ v: 1, type: "ready" }), origin: APP }, appCtx), null);
  const ok = { v: 1, type: "result", nonce, ok: true, result: accountResult() };
  assert.equal(acceptPasskeyWindowReply(reply(ok), appCtx)?.kind, "result");
  assert.equal(acceptPasskeyWindowReply(reply({ ...ok, nonce: newPasskeyWindowNonce() }), appCtx), null);
});

test("keys are 32-byte arrays, exactly the set for the action", () => {
  const send = (result: unknown, action: "signin" | "backup-get" = "signin") =>
    acceptPasskeyWindowReply(reply({ v: 1, type: "result", nonce, ok: true, result }), { ...appCtx, action })?.kind;
  assert.equal(send(accountResult()), "result");
  assert.equal(send({ ...accountResult(), keys: { ...accountKeys(), seed: new Uint8Array(31) } }), "unknown");
  assert.equal(send({ ...accountResult(), keys: { ...accountKeys(), seed: Array(32).fill(1) } }), "unknown");
  assert.equal(send({ ...accountResult(), keys: { ...accountKeys(), prf: key() } }), "unknown");
  const { seed: _s, ...missing } = accountKeys();
  assert.equal(send({ ...accountResult(), keys: missing }), "unknown");
  assert.equal(send({ ...accountResult(), extra: 1 }), "unknown");
  assert.equal(send({ ...accountResult(), attachment: "hybrid" }), "unknown");
  assert.equal(send({ keys: { ownerKey: key(), escrowMaster: key() } }, "backup-get"), "result");
  assert.equal(send({ keys: { ownerKey: key(), escrowMaster: key() } }), "unknown", "an account action never takes guardian keys");
  assert.equal(send(accountResult(), "backup-get"), "unknown", "a backup action never takes account keys");
});

test("errors are the known names only, and a newer window reads as unknown", () => {
  const err = (error: unknown) => acceptPasskeyWindowReply(reply({ v: 1, type: "result", nonce, ok: false, error }), appCtx);
  assert.deepEqual(err({ name: "NotAllowedError", quick: true }), { kind: "error", error: { name: "NotAllowedError", quick: true } });
  assert.deepEqual(err({ name: "PrfUnsupported", aaguid: null, label: "WoCo Backup" }), {
    kind: "error", error: { name: "PrfUnsupported", aaguid: null, label: "WoCo Backup" },
  });
  assert.deepEqual(err({ name: "TypeError" }), { kind: "unknown" });
  assert.deepEqual(acceptPasskeyWindowReply(reply({ v: 2, type: "ready" }), appCtx), { kind: "unknown" });
  assert.deepEqual(acceptPasskeyWindowReply(reply({ v: 1, type: "hello" }), appCtx), { kind: "unknown" });
});
