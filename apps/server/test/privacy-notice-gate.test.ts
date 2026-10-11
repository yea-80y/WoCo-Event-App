/**
 * No ticket sale until the organiser has confirmed their privacy notice
 * (`lib/legal/notice-gate.ts`, owner decision 2026-10-11). Both sale paths -
 * the seat hold and create-checkout - refuse before anything is held or
 * charged, an unreadable notice refuses (fail closed), and a confirmed one is
 * answered from memory so the money path does not wait on Swarm.
 *
 * MUTATION (each run once, each went red): drop the gate from create-checkout and
 * "create-checkout refuses ..." goes red; from reserve and "reserve refuses ..."
 * goes red; map `unavailable` to null in `noticeRefusal` and "an unreadable notice
 * refuses" goes red; cache `unavailable` and "unavailable is never kept" goes red;
 * remove the single-flight and "a rush costs one read" goes red; let
 * `noticeWritten` delete confirmed entries and "the organiser's own write marks
 * ... stale" goes red; serve a stale confirmed past the ceiling and "past the
 * ceiling ... fails closed" goes red; drop the relay hook and "the relay forgets
 * ..." goes red.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Bee } from "@ethersphere/bee-js";
import { ORGANISER_NOTICE_FORMAT, type EventFeed, type VersionedFeedRead } from "@woco/shared";

process.chdir(mkdtempSync(join(tmpdir(), "woco-notice-gate-")));
process.env.BEE_URL = "http://127.0.0.1:1";
process.env.EMAIL_HASH_SECRET ??= "0".repeat(64);
process.env.PAYMENT_QUOTE_SECRET ??= "5".repeat(64);
process.env.FEED_PRIVATE_KEY ??= "11".repeat(32);
process.env.WOCO_EVENT_CHAIN_ID ??= "84532";
delete process.env.STRIPE_SECRET_KEY;

const { stripeRoutes } = await import("../src/routes/stripe.js");
const { reservations } = await import("../src/routes/reservations.js");
const { __setBeeForTests } = await import("../src/config/swarm.js");
const gate = await import("../src/lib/legal/notice-gate.js");
const record = await import("../src/lib/event/feed-signer-record.js");
const service = await import("../src/lib/event/service.js");
const held = await import("../src/lib/attendee-batch/held-orders.js");
const writer = await import("../src/lib/attendee-batch/writer.js");
const { canonicalOrderBox } = await import("../src/lib/stripe/order-ref.js");
const { readyAttendeeStore } = await import("./helpers/attendee-store.js");
const { noRings } = await import("./helpers/key-ring.js");
const { enableFeature } = await import("./helpers/features.js");
const { agentRouter } = await import("../src/routes/agent.js");

__setBeeForTests({
  makeFeedReader() {
    return { async downloadPayload() { throw Object.assign(new Error("no feed here"), { status: 404 }); } };
  },
} as unknown as Bee);
globalThis.fetch = (() => { throw new Error("unexpected outbound fetch"); }) as unknown as typeof fetch;

const app = new Hono();
app.route("/api/stripe", stripeRoutes);
app.route("/api/events", reservations);
app.route("/api/agent", agentRouter);

const CREATOR = "0x" + "aa".repeat(20);
const SIGNER = "0x" + "f0".repeat(20);
const KEY = "0a".repeat(32);
const SERIES = "series-0001";

const confirmedNotice: VersionedFeedRead = {
  status: "found",
  bytes: new TextEncoder().encode(JSON.stringify({
    format: ORGANISER_NOTICE_FORMAT,
    address: CREATOR,
    organiserName: "Punk Pub Ltd",
    confirmedAt: "2026-10-11T09:00:00.000Z",
  })),
  version: 0,
  scanClean: true,
} as VersionedFeedRead;

let reads = 0;
let answer: () => Promise<VersionedFeedRead> = async () => confirmedNotice;
let now = 1_000_000;

beforeEach(() => {
  reads = 0;
  now = 1_000_000;
  answer = async () => confirmedNotice;
  gate.__setNoticeGateForTests({ reader: async () => { reads++; return answer(); }, now: () => now });
  noRings();
});

let seq = 0;
/** A recorded (#670), sale-ready-looking event. Fresh id per test so caches never cross. */
function liveEvent(opts: { recorded?: boolean; registered?: boolean } = {}): string {
  const eventId = `e0000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  if (opts.recorded !== false) record.recordEventFeedSigner(eventId, SIGNER, CREATOR, KEY);
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
    encryptionKeyRef: KEY,
    creatorFeedSigner: SIGNER,
    series: [{
      seriesId: SERIES,
      name: "GA",
      description: "",
      totalSupply: 10,
      // Unregistered: the next refusal after the gate, reached with no chain read.
      ...(opts.registered === false ? {} : { onChainEventId: "0x" + "01".repeat(32), swarmManifestRef: "02".repeat(32) }),
      manifestRef: "03".repeat(32),
      payment: { price: "10", currency: "GBP", stripeEnabled: true },
    }],
  } as unknown as EventFeed);
  return eventId;
}

let ipSeq = 0;
async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": `198.51.100.${++ipSeq % 250}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
const reserve = (eventId: string) => post(`/api/events/${eventId}/series/${SERIES}/reserve`, { quantity: 1 });
const BOX = { v: 2, enc: "ab".repeat(1120), ct: "cd".repeat(64) };
const checkout = (eventId: string, box = BOX) =>
  post("/api/stripe/create-checkout", { eventId, seriesId: SERIES, claimerEmail: "a@example.com", encryptedOrder: box, encryptionKeyRef: KEY });

// ── The sale paths ──────────────────────────────────────────────────────────

test("reserve refuses 409 PRIVACY_NOTICE_REQUIRED when the organiser has no confirmed notice", async () => {
  answer = async () => ({ status: "absent" });
  const r = await reserve(liveEvent());
  assert.equal(r.status, 409);
  assert.equal(r.json.code, gate.PRIVACY_NOTICE_REQUIRED);
  assert.match(String(r.json.error), /privacy notice/);
});

test("reserve: an invalid notice is no notice", async () => {
  answer = async () => ({ ...confirmedNotice, bytes: new TextEncoder().encode(JSON.stringify({ format: ORGANISER_NOTICE_FORMAT, address: "0x" + "bb".repeat(20), organiserName: "X", confirmedAt: "2026-10-11T09:00:00.000Z" })) } as VersionedFeedRead);
  assert.equal((await reserve(liveEvent())).json.code, gate.PRIVACY_NOTICE_REQUIRED);
});

test("reserve: an unreadable notice refuses 503 (fail closed)", async () => {
  answer = async () => ({ status: "unavailable", reason: "bee down" });
  const r = await reserve(liveEvent());
  assert.equal(r.status, 503);
  assert.equal(r.json.code, gate.PRIVACY_NOTICE_UNAVAILABLE);
});

test("reserve: a confirmed notice passes the gate (on to the registration check)", async () => {
  const r = await reserve(liveEvent({ registered: false }));
  assert.equal(r.status, 409);
  assert.match(String(r.json.error), /not currently on sale/);
  assert.notEqual(r.json.code, gate.PRIVACY_NOTICE_REQUIRED);
  assert.notEqual(r.json.code, gate.PRIVACY_NOTICE_UNAVAILABLE);
  assert.equal(reads, 1);
});

test("reserve: a legacy event and unreadable keys refuse like create-checkout, without reading a notice", async () => {
  const legacy = await reserve(liveEvent({ recorded: false }));
  assert.equal(legacy.status, 409);
  assert.equal(legacy.json.code, "EVENT_NEEDS_REPUBLISH");
  noRings({ down: true });
  const down = await reserve(liveEvent());
  assert.equal(down.status, 503);
  assert.equal(reads, 0);
});

test("create-checkout refuses 409 PRIVACY_NOTICE_REQUIRED before holding the order or charging", async () => {
  await readyAttendeeStore();
  answer = async () => ({ status: "absent" });
  const box = { ...BOX, ct: "e1".repeat(64) };
  const r = await checkout(liveEvent(), box);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, gate.PRIVACY_NOTICE_REQUIRED);
  assert.equal(held.getHeldOrder(await writer.orderRefOf(canonicalOrderBox(box)!)), null, "nothing held");
});

test("create-checkout: an unreadable notice refuses 503 (fail closed)", async () => {
  await readyAttendeeStore();
  answer = async () => { throw new Error("bee down"); };
  const r = await checkout(liveEvent(), { ...BOX, ct: "e2".repeat(64) });
  assert.equal(r.status, 503);
  assert.equal(r.json.code, gate.PRIVACY_NOTICE_UNAVAILABLE);
});

test("create-checkout: a confirmed notice passes the gate (on to the registration check)", async () => {
  await readyAttendeeStore();
  const r = await checkout(liveEvent({ registered: false }), { ...BOX, ct: "e3".repeat(64) });
  assert.equal(r.status, 409);
  assert.match(String(r.json.error), /not currently on sale/);
  assert.notEqual(r.json.code, gate.PRIVACY_NOTICE_REQUIRED);
  assert.notEqual(r.json.code, gate.PRIVACY_NOTICE_UNAVAILABLE);
});

test("the agent rail (flag-off) refuses the same way, so turning it on cannot sell past the gate", async () => {
  enableFeature("agentCommerceAllowed");
  try {
    answer = async () => ({ status: "absent" });
    const missing = await post("/api/agent/quote", { eventId: liveEvent(), seriesId: SERIES });
    assert.equal(missing.status, 409);
    assert.match(String(missing.json.error), /privacy notice/);
    answer = async () => ({ status: "unavailable", reason: "down" });
    now += gate.NOTICE_MISSING_TTL_MS + 1;
    assert.equal((await post("/api/agent/quote", { eventId: liveEvent(), seriesId: SERIES })).status, 503);
  } finally {
    enableFeature("agentCommerceAllowed", false);
  }
});

test("the only Stripe session creates are create-checkout (gated) and the flag-off shop rail", () => {
  // A new sale path must come through here and be gated too.
  const stripe = readFileSync(new URL("../src/routes/stripe.ts", import.meta.url), "utf-8");
  const shops = readFileSync(new URL("../src/routes/shops.ts", import.meta.url), "utf-8");
  assert.equal(stripe.split("checkout.sessions.create(").length - 1, 1);
  assert.ok(stripe.indexOf("noticeRefusal(await noticeVerdict)") < stripe.indexOf("checkout.sessions.create("));
  assert.match(shops, /shopAllowed/);
});

// ── The cache ───────────────────────────────────────────────────────────────

test("a confirmed verdict is answered from memory; a rush costs one read", async () => {
  const all = await Promise.all(Array.from({ length: 20 }, () => gate.organiserNoticeVerdict(CREATOR, SIGNER)));
  assert.ok(all.every((v) => v === "confirmed"));
  assert.equal(reads, 1);
  now += gate.NOTICE_FRESH_MS - 1;
  assert.equal(await gate.organiserNoticeVerdict(CREATOR, SIGNER), "confirmed");
  assert.equal(reads, 1);
});

test("a stale confirmed verdict is served at once and re-read in the background; a withdrawal lands", async () => {
  await gate.organiserNoticeVerdict(CREATOR, SIGNER);
  now += gate.NOTICE_FRESH_MS + 1;
  answer = async () => ({ status: "absent" });
  assert.equal(await gate.organiserNoticeVerdict(CREATOR, SIGNER), "confirmed");
  await new Promise((r) => setImmediate(r));
  assert.equal(reads, 2);
  assert.equal(await gate.organiserNoticeVerdict(CREATOR, SIGNER), "missing");
});

test("past the ceiling a stale confirmed verdict is not trusted: unreadable fails closed", async () => {
  await gate.organiserNoticeVerdict(CREATOR, SIGNER);
  answer = async () => ({ status: "unavailable", reason: "down" });
  now += gate.NOTICE_FRESH_MS + 1;
  assert.equal(await gate.organiserNoticeVerdict(CREATOR, SIGNER), "confirmed", "inside the ceiling");
  await new Promise((r) => setImmediate(r));
  now += gate.NOTICE_STALE_CEILING_MS;
  assert.equal(await gate.organiserNoticeVerdict(CREATOR, SIGNER), "unavailable");
});

test("unavailable is never kept", async () => {
  answer = async () => ({ status: "unavailable", reason: "down" });
  assert.equal(await gate.organiserNoticeVerdict(CREATOR, SIGNER), "unavailable");
  answer = async () => confirmedNotice;
  assert.equal(await gate.organiserNoticeVerdict(CREATOR, SIGNER), "confirmed");
  assert.equal(reads, 2);
});

test("missing is kept briefly; the organiser's own write forgets it at once", async () => {
  answer = async () => ({ status: "absent" });
  assert.equal(await gate.organiserNoticeVerdict(CREATOR, SIGNER), "missing");
  answer = async () => confirmedNotice;
  assert.equal(await gate.organiserNoticeVerdict(CREATOR, SIGNER), "missing", "inside the TTL");
  gate.noticeWritten(CREATOR.toUpperCase().replace("0X", "0x"));
  assert.equal(await gate.organiserNoticeVerdict(CREATOR, SIGNER), "confirmed");
  now += gate.NOTICE_MISSING_TTL_MS + 1;
  assert.equal(reads, 2);
});

test("the organiser's own write marks a confirmed notice stale - served at once, re-read behind", async () => {
  await gate.organiserNoticeVerdict(CREATOR, SIGNER);
  gate.noticeWritten(CREATOR);
  answer = async () => ({ status: "absent" });
  assert.equal(await gate.organiserNoticeVerdict(CREATOR, SIGNER), "confirmed", "never waits on a cold read");
  await new Promise((r) => setImmediate(r));
  assert.equal(reads, 2);
  // Straight after a write, "missing" may be a feed cache that has not caught up.
  assert.equal(await gate.organiserNoticeVerdict(CREATOR, SIGNER), "confirmed");
  await new Promise((r) => setImmediate(r));
  now += 10_001; // past the settle window, a withdrawn notice lands
  await gate.organiserNoticeVerdict(CREATOR, SIGNER);
  await new Promise((r) => setImmediate(r));
  assert.equal(await gate.organiserNoticeVerdict(CREATOR, SIGNER), "missing");
});

test("a write never extends how long a stale notice is trusted", async () => {
  await gate.organiserNoticeVerdict(CREATOR, SIGNER);
  answer = async () => ({ status: "unavailable", reason: "down" });
  now += gate.NOTICE_STALE_CEILING_MS + 1;
  gate.noticeWritten(CREATOR);
  assert.equal(await gate.organiserNoticeVerdict(CREATOR, SIGNER), "unavailable");
});

test("the public notice route reads the same cached notice as the sale gate", async () => {
  const first = await gate.organiserNoticeRead(CREATOR, SIGNER);
  assert.equal(first.status, "found");
  answer = async () => ({ status: "unavailable", reason: "down" });
  now += gate.NOTICE_FRESH_MS + 1;
  const during = await gate.organiserNoticeRead(CREATOR, SIGNER);
  assert.equal(during.status, "found", "inside the ceiling the page shows what checkout sells under");
  const src = readFileSync(new URL("../src/routes/privacy-notice.ts", import.meta.url), "utf-8");
  assert.equal(src.split("organiserNoticeRead(").length - 1, 2, "event and site reads");
  assert.doesNotMatch(src, /readOrganiserNotice\(/);
});

test("a read in flight when the organiser confirms never re-caches 'missing'", async () => {
  let release!: (r: VersionedFeedRead) => void;
  answer = () => new Promise((r) => { release = r; });
  const pending = gate.organiserNoticeVerdict(CREATOR, SIGNER);
  await new Promise((r) => setImmediate(r));
  gate.noticeWritten(CREATOR); // the confirm lands while the old read is out
  release({ status: "absent" });
  assert.equal(await pending, "missing", "that read answers what it saw");
  answer = async () => confirmedNotice;
  assert.equal(await gate.organiserNoticeVerdict(CREATOR, SIGNER), "confirmed", "but it was not kept");
});

test("just after a write, a 'missing' (a feed cache not caught up) is answered but not kept", async () => {
  gate.noticeWritten(CREATOR);
  now += 1;
  answer = async () => ({ status: "absent" });
  assert.equal(await gate.organiserNoticeVerdict(CREATOR, SIGNER), "missing");
  answer = async () => confirmedNotice;
  assert.equal(await gate.organiserNoticeVerdict(CREATOR, SIGNER), "confirmed");
});

test("keyed by signer: after a key-ring rotation the new signer's feed is read", async () => {
  await gate.organiserNoticeVerdict(CREATOR, SIGNER);
  answer = async () => ({ status: "absent" });
  assert.equal(await gate.organiserNoticeVerdict(CREATOR, "0x" + "f1".repeat(20)), "missing");
  assert.equal(reads, 2);
});

test("the relay forgets a missing verdict only for the writer's own account, after the upload", () => {
  const src = readFileSync(new URL("../src/routes/swarm.ts", import.meta.url), "utf-8");
  const upload = src.indexOf("await uploadSignedSoc(");
  const hook = src.indexOf("noticeWritten(parent)");
  assert.ok(upload > 0 && hook > upload, "after a successful upload");
  assert.match(src.slice(upload, hook), /const parent = \(c\.get\("parentAddress"\) as string\)\.toLowerCase\(\);/);
});

test("noticeRefusal: confirmed sells, missing is 409, unavailable is 503", () => {
  assert.equal(gate.noticeRefusal("confirmed"), null);
  assert.equal(gate.noticeRefusal("missing")?.status, 409);
  assert.equal(gate.noticeRefusal("unavailable")?.status, 503);
  for (const v of ["missing", "unavailable"] as const) assert.doesNotMatch(gate.noticeRefusal(v)!.body.error, /—|–/);
});
