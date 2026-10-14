/**
 * No sale for an event whose order key the server cannot vouch for (issue 896,
 * `lib/keyring/sale-keys.ts`). An event with no record (`legacy`) or a record with
 * no order key has only its own client-signed feed to name the key buyers seal to,
 * and that feed can be re-signed to any key. Every path that holds a seat, takes an
 * order box or charges refuses it with the code buyer surfaces already close on;
 * keys that cannot be read refuse with a 503.
 *
 * MUTATION (each run once, each went red): make `sellableKeys` pass a record with a
 * null order key, and the unit test plus every "record with no order key" route test
 * goes red; drop the call from reserve, prepare-order, create-checkout or the agent
 * rail, and that route's test goes red; map `unavailable` to a pass, and the 503 tests
 * go red; seal to the feed's key in fulfilment, and the static check goes red.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Bee } from "@ethersphere/bee-js";
import { EVENT_NEEDS_REPUBLISH, isSaleClosedCode, type EventFeed } from "@woco/shared";

process.chdir(mkdtempSync(join(tmpdir(), "woco-sale-keys-")));
process.env.BEE_URL = "http://127.0.0.1:1";
process.env.EMAIL_HASH_SECRET ??= "0".repeat(64);
process.env.PAYMENT_QUOTE_SECRET ??= "5".repeat(64);
process.env.FEED_PRIVATE_KEY ??= "11".repeat(32);
process.env.WOCO_EVENT_CHAIN_ID ??= "84532";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.POSTAGE_BATCH_ID;

const { stripeRoutes } = await import("../src/routes/stripe.js");
const { reservations } = await import("../src/routes/reservations.js");
const { agentRouter } = await import("../src/routes/agent.js");
const { __setBeeForTests } = await import("../src/config/swarm.js");
const record = await import("../src/lib/event/feed-signer-record.js");
const service = await import("../src/lib/event/service.js");
const held = await import("../src/lib/attendee-batch/held-orders.js");
const writer = await import("../src/lib/attendee-batch/writer.js");
const { canonicalOrderBox } = await import("../src/lib/stripe/order-ref.js");
const { sellableKeys, NOT_ON_SALE, ORDER_KEY_UNAVAILABLE } = await import("../src/lib/keyring/sale-keys.js");
const { readyAttendeeStore, acceptingUploadChunk } = await import("./helpers/attendee-store.js");
const { installRing, noRings } = await import("./helpers/key-ring.js");
const { confirmedNotices } = await import("./helpers/notice.js");
const { enableFeature } = await import("./helpers/features.js");

__setBeeForTests({
  makeFeedReader() {
    return { async downloadPayload() { throw Object.assign(new Error("no feed here"), { status: 404 }); } };
  },
  uploadChunk: acceptingUploadChunk,
} as unknown as Bee);

const app = new Hono();
app.route("/api/stripe", stripeRoutes);
app.route("/api/events", reservations);
app.route("/api/agent", agentRouter);

const CREATOR = "0x" + "aa".repeat(20);
const SIGNER = "0x" + "f0".repeat(20);
const KEY = "0a".repeat(32);
/** What a re-signed feed could name: a key the organiser never recorded. */
const FEED_KEY = "fe".repeat(32);
const SERIES = "series-0001";
const BOX = { v: 2, enc: "ab".repeat(1120), ct: "cd".repeat(64) };

beforeEach(() => {
  confirmedNotices();
  noRings();
});

let seq = 0;
/** A sale-ready-looking event. `key: false` = a record written before order keys were recorded. */
function liveEvent(opts: { recorded?: boolean; key?: boolean } = {}): string {
  const eventId = `e0000000-0000-4000-8896-${String(++seq).padStart(12, "0")}`;
  if (opts.recorded !== false) record.recordEventFeedSigner(eventId, SIGNER, CREATOR, opts.key === false ? undefined : KEY);
  service.primeEventCache(eventId, {
    v: 1,
    eventId,
    title: "Gig",
    description: "",
    imageHash: "00".repeat(32),
    startDate: "2099-01-01T00:00:00.000Z",
    endDate: "2099-01-02T00:00:00.000Z",
    location: "Pub",
    creatorAddress: CREATOR,
    createdAt: "2026-01-01T00:00:00.000Z",
    encryptionKeyRef: FEED_KEY,
    creatorFeedSigner: SIGNER,
    series: [{
      seriesId: SERIES,
      name: "GA",
      description: "",
      totalSupply: 10,
      // Unregistered: the next refusal after the key gate, reached with no chain read.
      manifestRef: "03".repeat(32),
      payment: { price: "10", currency: "GBP", stripeEnabled: true, cryptoEnabled: true },
    }],
  } as unknown as EventFeed);
  return eventId;
}

let ipSeq = 0;
async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": `203.0.113.${++ipSeq % 250}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
const reserve = (eventId: string) => post(`/api/events/${eventId}/series/${SERIES}/reserve`, { quantity: 1 });
const prepare = (eventId: string, box = BOX) => post("/api/stripe/prepare-order", { encryptedOrder: box, eventId });
const checkout = (eventId: string, box = BOX) =>
  post("/api/stripe/create-checkout", { eventId, seriesId: SERIES, claimerEmail: "a@example.com", encryptedOrder: box });

function assertNotOnSale(r: { status: number; json: Record<string, unknown> }, label: string): void {
  assert.equal(r.status, 409, label);
  assert.equal(r.json.code, EVENT_NEEDS_REPUBLISH, label);
  assert.equal(r.json.error, NOT_ON_SALE, label);
  assert.ok(isSaleClosedCode(r.json.code), `${label}: buyer surfaces close the form on it`);
}

// ── The helper ──────────────────────────────────────────────────────────────

test("sellableKeys: only a ring, or a record with an order key, may sell", () => {
  const creator = CREATOR;
  const feedSigner = SIGNER;
  assert.equal(sellableKeys({ kind: "ring", creator, feedSigner, orderKeyRef: KEY, gen: 1 }).ok, true);
  assert.equal(sellableKeys({ kind: "record", creator, feedSigner, orderKeyRef: KEY }).ok, true);
  for (const keys of [{ kind: "record", creator, feedSigner, orderKeyRef: null } as const, { kind: "legacy" } as const]) {
    const v = sellableKeys(keys);
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.equal(v.status, 409);
      assert.equal(v.body.code, EVENT_NEEDS_REPUBLISH);
    }
  }
  const down = sellableKeys({ kind: "unavailable", creator, feedSigner, reason: "rpc" });
  assert.equal(down.ok, false);
  if (!down.ok) {
    assert.equal(down.status, 503);
    assert.equal(down.body.code, ORDER_KEY_UNAVAILABLE);
  }
});

// ── Every sale path ─────────────────────────────────────────────────────────

test("reserve: a record with no order key, and a legacy event, hold no seat", async () => {
  assertNotOnSale(await reserve(liveEvent({ key: false })), "no order key");
  assertNotOnSale(await reserve(liveEvent({ recorded: false })), "legacy");
});

test("prepare-order: a box for an event with no order key on record is not held", async () => {
  await readyAttendeeStore();
  const box = { ...BOX, ct: "a1".repeat(64) };
  assertNotOnSale(await prepare(liveEvent({ key: false }), box), "no order key");
  assertNotOnSale(await prepare(liveEvent({ recorded: false }), box), "legacy");
  assert.equal(held.getHeldOrder(await writer.orderRefOf(canonicalOrderBox(box)!)), null, "nothing held");
});

test("create-checkout: an event with no order key on record is not charged, and its box is not held", async () => {
  await readyAttendeeStore();
  const box = { ...BOX, ct: "a2".repeat(64) };
  assertNotOnSale(await checkout(liveEvent({ key: false }), box), "no order key");
  assertNotOnSale(await checkout(liveEvent({ recorded: false }), box), "legacy");
  assert.equal(held.getHeldOrder(await writer.orderRefOf(canonicalOrderBox(box)!)), null, "nothing held");
  assert.equal((await checkout("e0000000-0000-4000-8896-00000000dead")).status, 404, "no event at all is still a 404");
});

test("the agent rail (flag-off) refuses the same way, so turning it on cannot sell past the gate", async () => {
  enableFeature("agentCommerceAllowed");
  try {
    const r = await post("/api/agent/quote", { eventId: liveEvent({ key: false }), seriesId: SERIES });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, NOT_ON_SALE);
  } finally {
    enableFeature("agentCommerceAllowed", false);
  }
});

test("keys that cannot be read refuse 503 on every path", async () => {
  await readyAttendeeStore();
  noRings({ down: true });
  const eventId = liveEvent();
  for (const [label, r] of [
    ["reserve", await reserve(eventId)],
    ["prepare-order", await prepare(eventId, { ...BOX, ct: "a3".repeat(64) })],
    ["create-checkout", await checkout(eventId, { ...BOX, ct: "a4".repeat(64) })],
  ] as const) {
    assert.equal(r.status, 503, label);
    assert.equal(r.json.code, ORDER_KEY_UNAVAILABLE, label);
  }
});

test("an event with its order key on record goes on past the gate - record or ring", async () => {
  await readyAttendeeStore();
  const recorded = liveEvent();
  const r = await reserve(recorded);
  assert.notEqual(r.json.code, EVENT_NEEDS_REPUBLISH);
  assert.match(String(r.json.error), /not currently on sale/, "the next refusal: an unregistered series");
  // A record with no key sells once the account has a ring: the ring's key is authoritative.
  const keyless = liveEvent({ key: false });
  await installRing(CREATOR);
  assert.notEqual((await reserve(keyless)).json.code, EVENT_NEEDS_REPUBLISH);
});

// ── The routes cannot drift ─────────────────────────────────────────────────

test("every sale route decides through sellableKeys, and fulfilment never seals to a feed-named key", () => {
  const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf-8");
  for (const route of ["routes/reservations.ts", "routes/stripe.ts", "routes/agent.ts"]) {
    const s = src(route);
    assert.match(s, /sellableKeys\(/, `${route} calls the gate`);
    assert.doesNotMatch(s, /kind === "legacy"/, `${route} has no route-local legacy rule`);
  }
  const stripe = src("routes/stripe.ts");
  assert.equal((stripe.match(/sellableKeys\(/g) ?? []).length, 2, "prepare-order and create-checkout");
  const fulfilment = src("lib/stripe/fulfilment.ts");
  assert.doesNotMatch(fulfilment, /fetchOrderKey\(\s*ev\./, "the fallback seal never reads the key from the feed");
  assert.match(fulfilment, /fetchOrderKey\(keyVerdict\.keys\.orderKeyRef\)/);
});
