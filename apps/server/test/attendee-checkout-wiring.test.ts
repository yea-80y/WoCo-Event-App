/**
 * The checkout routes and the attendee order store (#546). Order data may only
 * be written where it can be erased, and when that is not possible the sale is
 * refused BEFORE anything is spent or charged: fulfilment's fallback seal goes
 * to the same store, so taking the card anyway would end in a refund.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Bee } from "@ethersphere/bee-js";

process.chdir(mkdtempSync(join(tmpdir(), "woco-attendee-wiring-")));
process.env.BEE_URL = "http://127.0.0.1:1";
process.env.EMAIL_HASH_SECRET ??= "0".repeat(64);
process.env.PAYMENT_QUOTE_SECRET ??= "5".repeat(64);
process.env.FEED_PRIVATE_KEY ??= "11".repeat(32);
delete process.env.ATTENDEE_STAMPER_PRIVATE_KEY;
delete process.env.STRIPE_SECRET_KEY;

const { stripeRoutes } = await import("../src/routes/stripe.js");
const { __setBeeForTests } = await import("../src/config/swarm.js");
const ledger = await import("../src/lib/attendee-batch/ledger.js");
const { readyAttendeeStore, acceptingUploadChunk } = await import("./helpers/attendee-store.js");
const { canonicalOrderBox } = await import("../src/lib/stripe/order-ref.js");
const held = await import("../src/lib/attendee-batch/held-orders.js");
const writer = await import("../src/lib/attendee-batch/writer.js");

let feedReads = 0;
let chunksUploaded = 0;
__setBeeForTests({
  makeFeedReader() {
    feedReads++;
    return { async downloadPayload() { throw Object.assign(new Error("no feed here"), { status: 404 }); } };
  },
  async uploadChunk(stamp: unknown, body: Uint8Array) {
    chunksUploaded++;
    return acceptingUploadChunk(stamp, body);
  },
} as unknown as Bee);
globalThis.fetch = (() => {
  throw new Error("unexpected outbound fetch");
}) as unknown as typeof fetch;

const app = new Hono();
app.route("/api/stripe", stripeRoutes);

const BOX = { v: 2, enc: "ab".repeat(1120), ct: "cd".repeat(64) };

function post(path: string, body: unknown, ip: string): Promise<Response> {
  return app.request(`/api/stripe/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  });
}

test("with no erasable storage, checkout is refused 503 before any read or spend", async () => {
  const res = await post("create-checkout", { eventId: "evt-1", seriesId: "s1", claimerEmail: "a@example.com" }, "198.51.100.1");
  assert.equal(res.status, 503);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.match(body.error, /paused/i);
  assert.doesNotMatch(body.error, /stamper|batch|ledger/i, "operator detail stays in the log");
  assert.equal(feedReads, 0);
  assert.equal(chunksUploaded, 0);
});

test("with no erasable storage, prepare-order is refused 503 and stores nothing", async () => {
  const res = await post("prepare-order", { encryptedOrder: BOX }, "198.51.100.2");
  assert.equal(res.status, 503);
  assert.equal(chunksUploaded, 0);
});

test("once ready, prepare-order HOLDS the box and stores nothing on Swarm (#546 paid-only)", async () => {
  await readyAttendeeStore();
  const before = chunksUploaded;
  const res = await post("prepare-order", { encryptedOrder: BOX }, "198.51.100.3");
  assert.equal(res.status, 200);
  const { orderRef, orderRefToken } = (await res.json()) as { orderRef: string; orderRefToken: string };
  assert.ok(orderRefToken);
  assert.equal(chunksUploaded, before, "no slot is spent before payment");
  assert.equal(ledger.getOrderRecord(orderRef), null);
  assert.equal(held.getHeldOrder(orderRef)?.json, canonicalOrderBox(BOX));
  assert.equal(orderRef, await writer.orderRefOf(canonicalOrderBox(BOX)!), "the ref is the root the bytes will have");
});

test("an order box sent with an event that does not exist holds and stores nothing", async () => {
  const before = chunksUploaded;
  const box = { ...BOX, ct: "ee".repeat(64) };
  const res = await post(
    "create-checkout",
    { eventId: "evt-missing", seriesId: "s1", claimerEmail: "a@example.com", encryptedOrder: box },
    "198.51.100.4",
  );
  assert.equal(res.status, 404);
  assert.equal(chunksUploaded, before);
  assert.equal(held.getHeldOrder(await writer.orderRefOf(canonicalOrderBox(box)!)), null);
});

test("a paid hold is stored under exactly its ref and released; the retry worker ignores unpaid holds", async () => {
  await readyAttendeeStore();
  const deps = { stamper: writer.getAttendeeStamper, upload: async (_e: unknown, body: Uint8Array) => { chunksUploaded++; return (await acceptingUploadChunk(_e, body)).reference.toHex(); } };
  const json = canonicalOrderBox({ ...BOX, ct: "ab".repeat(80) })!;
  const ref = await writer.orderRefOf(json);
  held.commitHold(ref, json, { eventId: "e9", seriesId: "s9" });
  const before = chunksUploaded;
  assert.deepEqual(await writer.retryPaidHeldOrders(20, deps as never), { stored: 0, failed: 0 }, "unpaid: not stored");
  assert.equal(chunksUploaded, before);
  held.markHeldPaid(ref, "cs_9");
  assert.deepEqual(await writer.retryPaidHeldOrders(20, deps as never), { stored: 1, failed: 0 });
  assert.equal(ledger.getOrderRecord(ref)?.state, "stored");
  assert.equal(ledger.getOrderRecord(ref)?.eventId, "e9");
  assert.equal(held.getHeldOrder(ref), null, "hold released once stored");
});

test("a hold whose bytes do not hash to its ref is never released as stored", async () => {
  await readyAttendeeStore();
  const deps = { stamper: writer.getAttendeeStamper, upload: async (_e: unknown, body: Uint8Array) => (await acceptingUploadChunk(_e, body)).reference.toHex() };
  const wrongRef = "cd".repeat(32);
  held.commitHold(wrongRef, canonicalOrderBox({ ...BOX, ct: "99".repeat(70) })!, {});
  held.markHeldPaid(wrongRef, "cs_w");
  await assert.rejects(writer.storeHeldOrder(wrongRef, deps as never), /hashes to/);
  assert.ok(held.getHeldOrder(wrongRef), "hold kept");
  held.releaseHeldOrder(wrongRef);
});

test("burning an order that is only held deletes the hold", async () => {
  process.env.OPS_TOKEN = "t".repeat(40);
  const { ops } = await import("../src/routes/ops.js");
  const opsApp = new Hono();
  opsApp.route("/api/ops", ops);
  const json = canonicalOrderBox({ ...BOX, ct: "77".repeat(66) })!;
  const ref = await writer.orderRefOf(json);
  held.commitHold(ref, json, {});
  const res = await opsApp.request(`/api/ops/attendee-batch/orders/${ref}/burn`, {
    method: "POST",
    headers: { authorization: `Bearer ${"t".repeat(40)}`, "content-type": "application/json" },
    body: JSON.stringify({ by: "test", reason: "erasure request" }),
  });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { data: { state: string } }).data.state, "deleted-before-store");
  assert.equal(held.getHeldOrder(ref), null);
  // A tombstone: readers skip it, and nothing can store it later.
  assert.equal(ledger.isOrderErased(ref), true);
  held.commitHold(ref, json, {});
  held.markHeldPaid(ref, "cs_late");
  await assert.rejects(writer.storeHeldOrder(ref), /erased/);
  held.releaseHeldOrder(ref);
});

test("a burn while that order's store is in flight is refused 409, then works once the store lands", async () => {
  await readyAttendeeStore();
  process.env.OPS_TOKEN = "t".repeat(40);
  const { ops } = await import("../src/routes/ops.js");
  const opsApp = new Hono();
  opsApp.route("/api/ops", ops);
  const burn = () =>
    opsApp.request(`/api/ops/attendee-batch/orders/${ref}/burn`, {
      method: "POST",
      headers: { authorization: `Bearer ${"t".repeat(40)}`, "content-type": "application/json" },
      body: JSON.stringify({ by: "test", reason: "erasure request" }),
    });
  const json = canonicalOrderBox({ ...BOX, ct: "55".repeat(90) })!;
  const ref = await writer.orderRefOf(json);
  held.commitHold(ref, json, {});
  held.markHeldPaid(ref, "cs_race");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow = {
    stamper: writer.getAttendeeStamper,
    upload: async (_e: unknown, body: Uint8Array) => {
      await gate;
      return (await acceptingUploadChunk(_e, body)).reference.toHex();
    },
  };
  const storing = writer.storeHeldOrder(ref, slow as never);
  await new Promise((r) => setImmediate(r));
  assert.equal(writer.isStoreInFlight(ref), true);
  assert.equal((await burn()).status, 409);
  assert.ok(held.getHeldOrder(ref), "the hold was not deleted underneath the store");
  release();
  await storing;
  assert.equal(ledger.getOrderRecord(ref)?.state, "stored");
});

test("the organiser's order view checks erasure before it fetches anything", () => {
  const src = readFileSync(new URL("../src/routes/orders.ts", import.meta.url), "utf8");
  const check = src.indexOf("const erased = swarmHex ? isOrderErased(swarmHex) : false;");
  const heldGate = src.indexOf("const held = swarmHex && !erased ? getHeldOrder(swarmHex) : null;");
  const guard = src.indexOf("} else if (swarmHex && !erased) {");
  const fetch = src.indexOf("await downloadFromBytes(swarmHex)");
  assert.ok(check > 0 && heldGate > check, "a held order is served only when not erased");
  assert.ok(guard > heldGate && fetch > guard, "erasure is decided before the download, and gates it");
});

test("#546: a stored order carries its organiser and the buyer's email hash, and the ops lookup finds it", async () => {
  await readyAttendeeStore();
  const { recordEventFeedSigner } = await import("../src/lib/event/feed-signer-record.js");
  const { hashEmail } = await import("../src/lib/event/claim-service.js");
  const organiser = "0x" + "5c".repeat(20);
  recordEventFeedSigner("e-lookup", "0x" + "da".repeat(20), organiser);
  const emailHash = hashEmail(" Buyer@Example.com ");

  const deps = { stamper: writer.getAttendeeStamper, upload: async (_e: unknown, body: Uint8Array) => (await acceptingUploadChunk(_e, body)).reference.toHex() };
  const json = canonicalOrderBox({ ...BOX, ct: "e1".repeat(77) })!;
  const ref = await writer.orderRefOf(json);
  held.commitHold(ref, json, { eventId: "e-lookup", seriesId: "s1" });
  assert.equal(held.markHeldPaid(ref, "cs_lookup", Date.now(), { emailHash }), true);
  assert.equal(held.getHeldOrder(ref)?.emailHash, emailHash, "the hash rides the hold until storage");

  process.env.OPS_TOKEN = "t".repeat(40);
  const { ops } = await import("../src/routes/ops.js");
  const opsApp = new Hono();
  opsApp.route("/api/ops", ops);
  const lookup = async (body: unknown) => {
    const res = await opsApp.request("/api/ops/attendee-batch/lookup", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${"t".repeat(40)}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as { data?: { orders: { root: string; organiser: string | null; state: string }[]; held: { root: string }[] } } };
  };

  const beforeStore = await lookup({ email: "buyer@example.com" });
  assert.deepEqual(beforeStore.body.data?.held.map((h) => h.root), [ref], "paid but not stored yet: found among the holds");

  await writer.storeHeldOrder(ref, deps as never);
  const rec = ledger.getOrderRecord(ref);
  assert.equal(rec?.organiser, organiser, "organiser from the record pinned at create");
  assert.equal(rec?.emailHash, emailHash);

  const afterStore = await lookup({ email: "BUYER@example.com" });
  assert.equal(afterStore.status, 200);
  assert.deepEqual(afterStore.body.data?.orders.map((o) => [o.root, o.organiser, o.state]), [[ref, organiser, "stored"]]);
  assert.deepEqual(afterStore.body.data?.held, []);
  assert.equal((await lookup({ emailHash })).body.data?.orders.length, 1, "the hash works as well as the address");
  assert.equal((await lookup({})).status, 400);
  assert.equal((await lookup({ email: "someone-else@example.com" })).body.data?.orders.length, 0);
});

test("#546: an order erased while only held keeps who it was for, so a later request is answered 'erased'", async () => {
  await readyAttendeeStore();
  const { hashEmail } = await import("../src/lib/event/claim-service.js");
  const emailHash = hashEmail("held-only@example.com");
  const json = canonicalOrderBox({ ...BOX, ct: "f3".repeat(71) })!;
  const ref = await writer.orderRefOf(json);
  held.commitHold(ref, json, { eventId: "e-lookup", seriesId: "s2" });
  held.markHeldPaid(ref, "cs_heldonly", Date.now(), { emailHash });

  process.env.OPS_TOKEN = "t".repeat(40);
  const { ops } = await import("../src/routes/ops.js");
  const opsApp = new Hono();
  opsApp.route("/api/ops", ops);
  const auth = { "content-type": "application/json", authorization: `Bearer ${"t".repeat(40)}` };
  const burn = await opsApp.request(`/api/ops/attendee-batch/orders/${ref}/burn`, {
    method: "POST", headers: auth, body: JSON.stringify({ by: "test", reason: "erasure request" }),
  });
  assert.equal(((await burn.json()) as { data?: { state: string } }).data?.state, "deleted-before-store");

  const rec = ledger.getOrderRecord(ref);
  assert.equal(rec?.state, "burned");
  assert.equal(rec?.emailHash, emailHash);
  assert.equal(rec?.eventId, "e-lookup");
  assert.equal(rec?.organiser, "0x" + "5c".repeat(20), "organiser from the record pinned at create");

  const res = await opsApp.request("/api/ops/attendee-batch/lookup", {
    method: "POST", headers: auth, body: JSON.stringify({ email: "held-only@example.com" }),
  });
  const data = ((await res.json()) as { data: { orders: { root: string; state: string }[]; held: unknown[] } }).data;
  assert.deepEqual(data.orders.map((o) => [o.root, o.state]), [[ref, "burned"]]);
  assert.deepEqual(data.held, []);
});
