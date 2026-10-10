/**
 * Pairing mailbox (#746 step 4): the transport rules, and only those - each slot
 * written once and in order, everything gone after the TTL, malformed input
 * refused before it is stored. The server reads none of what it holds.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { PAIRING_MAX_BOX_CHARS, PAIRING_TTL_MS } from "@woco/shared";
import {
  MAX_LIVE_PAIRINGS,
  getPairingSlot,
  putPairingSlot,
  __resetPairingsForTest,
} from "../src/lib/auth/pairing-mailbox.js";
import { pairing } from "../src/routes/pairing.js";

const ID = "a".repeat(64);
const OTHER = "b".repeat(64);
const T0 = 1_000_000;

beforeEach(() => __resetPairingsForTest());

test("slots are written once each, in order", () => {
  assert.equal(putPairingSlot(ID, "answer", "x", T0), "gone");
  assert.equal(putPairingSlot(ID, "offer", "o", T0), "ok");
  assert.equal(putPairingSlot(ID, "offer", "o2", T0), "exists");
  assert.equal(putPairingSlot(ID, "reply", "r", T0), "out-of-order");
  assert.equal(putPairingSlot(ID, "answer", "a", T0), "ok");
  assert.equal(putPairingSlot(ID, "answer", "a2", T0), "exists");
  assert.equal(putPairingSlot(ID, "reply", "r", T0), "ok");
  assert.equal(putPairingSlot(ID, "reply", "r2", T0), "exists");
  assert.equal(getPairingSlot(ID, "offer", T0), "o");
  assert.equal(getPairingSlot(ID, "answer", T0), "a");
  assert.equal(getPairingSlot(ID, "reply", T0), "r");
});

test("an empty slot reads null; an unknown pairing reads gone", () => {
  putPairingSlot(ID, "offer", "o", T0);
  assert.equal(getPairingSlot(ID, "answer", T0), null);
  assert.equal(getPairingSlot(OTHER, "offer", T0), "gone");
});

test("the whole pairing expires together, from the offer", () => {
  putPairingSlot(ID, "offer", "o", T0);
  putPairingSlot(ID, "answer", "a", T0 + PAIRING_TTL_MS - 1);
  assert.equal(getPairingSlot(ID, "answer", T0 + PAIRING_TTL_MS - 1), "a");
  assert.equal(getPairingSlot(ID, "answer", T0 + PAIRING_TTL_MS), "gone");
  assert.equal(putPairingSlot(ID, "reply", "r", T0 + PAIRING_TTL_MS), "gone");
  // Expired, so the id is free again - a new offer under it starts a new pairing.
  assert.equal(putPairingSlot(ID, "offer", "o2", T0 + PAIRING_TTL_MS), "ok");
  assert.equal(getPairingSlot(ID, "answer", T0 + PAIRING_TTL_MS), null);
});

test("live pairings are capped; expired ones make room", () => {
  const id = (i: number) => i.toString(16).padStart(64, "0");
  for (let i = 0; i < MAX_LIVE_PAIRINGS; i++) assert.equal(putPairingSlot(id(i), "offer", "o", T0), "ok");
  assert.equal(putPairingSlot(id(MAX_LIVE_PAIRINGS), "offer", "o", T0 + 1), "full");
  assert.equal(putPairingSlot(id(MAX_LIVE_PAIRINGS), "offer", "o", T0 + PAIRING_TTL_MS), "ok");
});

const app = new Hono();
app.route("/api/pairing", pairing);

function post(path: string, body: unknown, ip = "198.51.100.1") {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function get(path: string, ip = "198.51.100.1") {
  return app.request(path, { headers: { "CF-Connecting-IP": ip } });
}

test("routes: round trip, refusals in the API shape", async () => {
  assert.equal((await post(`/api/pairing/${ID}/offer`, { box: "b64_url-OK" })).status, 200);
  assert.equal((await post(`/api/pairing/${ID}/offer`, { box: "again" })).status, 409);
  const pending = await get(`/api/pairing/${ID}/answer`);
  assert.equal(pending.status, 200);
  assert.deepEqual(await pending.json(), { ok: true, data: { box: null } });
  assert.equal(pending.headers.get("Cache-Control"), "no-store");
  assert.equal((await post(`/api/pairing/${ID}/reply`, { box: "r" })).status, 409);
  assert.equal((await post(`/api/pairing/${ID}/answer`, { box: "ans" })).status, 200);
  assert.deepEqual(await (await get(`/api/pairing/${ID}/answer`)).json(), { ok: true, data: { box: "ans" } });
  const gone = await get(`/api/pairing/${OTHER}/offer`);
  assert.equal(gone.status, 410);
  assert.equal((await gone.json()).code, "gone");
});

test("routes: malformed ids, slots and boxes are refused before anything is stored", async () => {
  assert.equal((await post(`/api/pairing/${"A".repeat(64)}/offer`, { box: "x" })).status, 404);
  assert.equal((await post(`/api/pairing/${ID.slice(1)}/offer`, { box: "x" })).status, 404);
  assert.equal((await post(`/api/pairing/${ID}/other`, { box: "x" })).status, 404);
  assert.equal((await post(`/api/pairing/${ID}/offer`, { box: "not base64url!" })).status, 400);
  assert.equal((await post(`/api/pairing/${ID}/offer`, { box: 7 })).status, 400);
  assert.equal((await post(`/api/pairing/${ID}/offer`, "not json")).status, 400);
  assert.equal((await post(`/api/pairing/${ID}/offer`, { box: "x".repeat(PAIRING_MAX_BOX_CHARS + 1) })).status, 400);
  assert.equal(getPairingSlot(ID, "offer"), "gone");
});

test("routes: offers are rate-limited per address", async () => {
  const ip = "203.0.113.9";
  const id = (i: number) => `c${i.toString(16).padStart(63, "0")}`;
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) statuses.push((await post(`/api/pairing/${id(i)}/offer`, { box: "o" }, ip)).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
  assert.equal(statuses[10], 429);
});
