/**
 * Checkout refuses an order sealed to a key the organiser's account has moved on from
 * (#186): once the account has a key ring, a page loaded before a passkey was removed
 * would seal the buyer's details to a key that passkey still holds.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Bee } from "@ethersphere/bee-js";
import type { EventFeed } from "@woco/shared";

process.chdir(mkdtempSync(join(tmpdir(), "woco-checkout-order-key-")));
process.env.BEE_URL = "http://127.0.0.1:1";
process.env.EMAIL_HASH_SECRET ??= "0".repeat(64);
process.env.FEED_PRIVATE_KEY ??= "11".repeat(32);
process.env.PAYMENT_QUOTE_SECRET ??= "51".repeat(32);
delete process.env.POSTAGE_BATCH_ID;
delete process.env.STRIPE_SECRET_KEY;

const { stripeRoutes } = await import("../src/routes/stripe.js");
const { __setBeeForTests } = await import("../src/config/swarm.js");
const { readyAttendeeStore, acceptingUploadChunk } = await import("./helpers/attendee-store.js");
const { installRing, noRings } = await import("./helpers/key-ring.js");
const record = await import("../src/lib/event/feed-signer-record.js");
const service = await import("../src/lib/event/service.js");

__setBeeForTests({
  makeFeedReader() {
    return { async downloadPayload() { throw Object.assign(new Error("no feed here"), { status: 404 }); } };
  },
  uploadChunk: acceptingUploadChunk,
} as unknown as Bee);

const app = new Hono();
app.route("/api/stripe", stripeRoutes);

const EVENT = "e0000000-0000-4000-8000-0000000000c1";
const SERIES = "s0000000-0000-4000-8000-0000000000c1";
const CREATOR = "0x" + "aa".repeat(20);
const F0 = "0x" + "f0".repeat(20);
const K0 = "0a".repeat(32);
const K1 = "1b".repeat(32);
const BOX = { v: 2, enc: "ab".repeat(1120), ct: "cd".repeat(64) };

let ipSeq = 0;
async function post(path: string, body: unknown): Promise<{ status: number; code?: string; encryptionKeyRef?: string }> {
  const ip = `198.51.100.${++ipSeq}`;
  const res = await app.request(`/api/stripe/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { code?: string; encryptionKeyRef?: string };
  // A refusal names the key to re-seal to (#186).
  return { status: res.status, code: json.code, ...(json.encryptionKeyRef ? { encryptionKeyRef: json.encryptionKeyRef } : {}) };
}

record.recordEventFeedSigner(EVENT, F0, CREATOR, K0);
await readyAttendeeStore();

test("prepare-order, no ring: an undeclared key passes (older clients); a declared wrong one is refused", async () => {
  noRings();
  assert.equal((await post("prepare-order", { encryptedOrder: BOX, eventId: EVENT })).status, 200);
  assert.equal((await post("prepare-order", { encryptedOrder: { ...BOX, ct: "ce".repeat(64) }, eventId: EVENT, encryptionKeyRef: K0 })).status, 200);
  assert.deepEqual(await post("prepare-order", { encryptedOrder: BOX, eventId: EVENT, encryptionKeyRef: K1 }), {
    status: 409,
    code: "ORDER_KEY_STALE",
    encryptionKeyRef: K0,
  });
});

test("prepare-order, ring: only the ring's key passes; the old one and none are refused before anything is held", async () => {
  const r = await installRing(CREATOR);
  assert.equal((await post("prepare-order", { encryptedOrder: { ...BOX, ct: "cf".repeat(64) }, eventId: EVENT, encryptionKeyRef: r.orderKeyRef })).status, 200);
  for (const encryptionKeyRef of [K0, undefined]) {
    assert.deepEqual(await post("prepare-order", { encryptedOrder: BOX, eventId: EVENT, encryptionKeyRef }), {
      status: 409,
      code: "ORDER_KEY_STALE",
      encryptionKeyRef: r.orderKeyRef,
    });
  }
});

test("prepare-order: keys that cannot be read stop the sale", async () => {
  noRings({ down: true });
  assert.equal((await post("prepare-order", { encryptedOrder: BOX, eventId: EVENT, encryptionKeyRef: K0 })).status, 503);
});

test("create-checkout: a box sealed to the old generation's key is refused at charge time", async () => {
  const r = await installRing(CREATOR);
  const feed = {
    v: 1,
    eventId: EVENT,
    title: "T",
    description: "",
    imageHash: "00".repeat(32),
    startDate: "2099-01-01T00:00:00.000Z",
    endDate: "2099-01-02T00:00:00.000Z",
    location: "L",
    creatorAddress: CREATOR,
    createdAt: "2026-01-01T00:00:00.000Z",
    encryptionKeyRef: K0,
    creatorFeedSigner: r.feedSigner,
    series: [{ seriesId: SERIES, name: "GA", totalSupply: 10, price: 5, payment: { price: "5.00", currency: "GBP", stripeEnabled: true } }],
  } as unknown as EventFeed;
  service.primeEventCache(EVENT, feed);
  const base = { eventId: EVENT, seriesId: SERIES, claimerEmail: "a@example.com", encryptedOrder: BOX };
  const stale = { status: 409, code: "ORDER_KEY_STALE", encryptionKeyRef: r.orderKeyRef };
  assert.deepEqual(await post("create-checkout", { ...base, encryptionKeyRef: K0 }), stale);
  assert.deepEqual(await post("create-checkout", base), stale);
  const ok = await post("create-checkout", { ...base, encryptionKeyRef: r.orderKeyRef });
  assert.notEqual(ok.code, "ORDER_KEY_STALE");
});

test("create-checkout: keys that cannot be read pause the sale, even with the event cached", async () => {
  // The event is still in the money-path cache from the test above; the chain is not.
  noRings({ down: true });
  const res = await post("create-checkout", { eventId: EVENT, seriesId: SERIES, claimerEmail: "a@example.com", encryptedOrder: BOX, encryptionKeyRef: K0 });
  assert.equal(res.status, 503);
});

test("create-checkout: an organiser-signed event with no record is not sold (owner 10-09)", async () => {
  noRings();
  const LEGACY = "e0000000-0000-4000-8000-0000000000c9";
  service.primeEventCache(LEGACY, {
    v: 1,
    eventId: LEGACY,
    title: "Before records",
    description: "",
    imageHash: "00".repeat(32),
    startDate: "2099-01-01T00:00:00.000Z",
    endDate: "2099-01-02T00:00:00.000Z",
    location: "L",
    creatorAddress: CREATOR,
    createdAt: "2026-01-01T00:00:00.000Z",
    encryptionKeyRef: K0,
    creatorFeedSigner: F0,
    series: [{ seriesId: SERIES, name: "GA", totalSupply: 10, price: 5, payment: { price: "5.00", currency: "GBP", stripeEnabled: true } }],
  } as unknown as EventFeed);
  // No platform feed for it: the server never wrote one, so an organiser did.
  service.__setPlatformFeedReadForTests(async () => ({ status: "absent" }));
  const buy = () => post("create-checkout", { eventId: LEGACY, seriesId: SERIES, claimerEmail: "a@example.com", encryptedOrder: BOX, encryptionKeyRef: K0 });
  assert.deepEqual(await buy(), { status: 409, code: "EVENT_NEEDS_REPUBLISH" });
  // The same feed without its creatorFeedSigner field: whoever signs it can drop the
  // field, so the decision is where the feed is (no platform feed here), not what it says.
  const cached = await service.getEvent(LEGACY);
  const { creatorFeedSigner: _dropped, ...withoutSigner } = cached as EventFeed & { creatorFeedSigner?: string };
  service.primeEventCache(LEGACY, withoutSigner as EventFeed);
  assert.deepEqual(await buy(), { status: 409, code: "EVENT_NEEDS_REPUBLISH" });
  // A platform-signed legacy event (the server wrote its feed) still sells - and what is
  // sold is THAT feed, not an organiser-signed copy found first: here the copy says
  // "free" and the platform feed says "5.00", and only a 5.00 sale gets past the price.
  const { encodeJsonFeed } = await import("../src/lib/swarm/feeds.js");
  const platformFeed = { ...withoutSigner, title: "Platform copy" } as EventFeed;
  service.primeEventCache(LEGACY, {
    ...withoutSigner,
    series: [{ seriesId: SERIES, name: "GA", totalSupply: 10, price: 0, payment: { price: "0", currency: "GBP", stripeEnabled: true } }],
  } as unknown as EventFeed);
  service.__setPlatformFeedReadForTests(async () => ({ status: "ok", data: encodeJsonFeed(platformFeed) }));
  const sold = await buy();
  assert.notEqual(sold.code, "EVENT_NEEDS_REPUBLISH");
  assert.notEqual(sold.status, 400, "the organiser copy's invalid price was not what got checked");
  service.__setPlatformFeedReadForTests(async () => ({ status: "error", error: new Error("bee down") }));
  assert.equal((await buy()).status, 503);
  service.__setPlatformFeedReadForTests(null);
});
