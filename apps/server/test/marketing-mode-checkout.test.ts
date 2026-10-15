/**
 * The checkout's marketing mode comes from the organiser's CONFIRMED notice, and
 * create-checkout refuses a page that showed the other one (soft opt-in,
 * owner 2026-10-14). An untouched box means YES in own-events mode and NO in
 * consent mode, so a choice made under the wrong mode would be recorded as the
 * opposite of what the buyer chose - the refusal comes before anything is held
 * or charged.
 *
 * MUTATION (each run once, each went red): drop the mode comparison from
 * create-checkout and "a page that showed the other mode is refused" goes red;
 * move it after the hold and "nothing held" goes red; let `parseMarketingChoice`
 * pass an unknown version and "a malformed choice is a 400" goes red; return the
 * draft default from `noticeMarketingMode` and "claim-status returns the mode"
 * goes red; drop a key from `marketingMetadata` and "the metadata carries" goes
 * red; leave the tag off the marketing keys and "the tag commits" goes red.
 * Since 2026-10-15 the page also sends the words it showed: drop the wording
 * comparison and "a page whose words differ" goes red; build the rebuilt words
 * from anything but the event's questions and "older questions" goes red; drop
 * the version check and "an older version" goes red; leave the hash off the
 * metadata and "the metadata carries" goes red.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Bee } from "@ethersphere/bee-js";
import {
  listKeeps,
  MARKETING_MODE_CHANGED,
  MARKETING_WORDING_CHANGED,
  marketingWording,
  ORGANISER_NOTICE_FORMAT,
  type EventFeed,
  type MarketingMode,
  type OrderField,
  type VersionedFeedRead,
} from "@woco/shared";

process.chdir(mkdtempSync(join(tmpdir(), "woco-marketing-mode-")));
process.env.BEE_URL = "http://127.0.0.1:1";
process.env.EMAIL_HASH_SECRET ??= "0".repeat(64);
process.env.PAYMENT_QUOTE_SECRET ??= "5".repeat(64);
process.env.FEED_PRIVATE_KEY ??= "11".repeat(32);
process.env.WOCO_EVENT_CHAIN_ID ??= "84532";
delete process.env.STRIPE_SECRET_KEY;

const { stripeRoutes } = await import("../src/routes/stripe.js");
const { claims } = await import("../src/routes/claims.js");
const { __setBeeForTests } = await import("../src/config/swarm.js");
const gate = await import("../src/lib/legal/notice-gate.js");
const record = await import("../src/lib/event/feed-signer-record.js");
const service = await import("../src/lib/event/service.js");
const held = await import("../src/lib/attendee-batch/held-orders.js");
const writer = await import("../src/lib/attendee-batch/writer.js");
const { canonicalOrderBox } = await import("../src/lib/stripe/order-ref.js");
const { readyAttendeeStore } = await import("./helpers/attendee-store.js");
const { noRings } = await import("./helpers/key-ring.js");
const { marketingMetadata, marketingFromMetadata, marketingWordingHash } = await import("../src/lib/marketing/checkout-choice.js");
const { signCheckoutTag, verifyCheckoutTag } = await import("../src/lib/stripe/checkout-provenance.js");

__setBeeForTests({
  makeFeedReader() {
    return { async downloadPayload() { throw Object.assign(new Error("no feed here"), { status: 404 }); } };
  },
} as unknown as Bee);
globalThis.fetch = (() => { throw new Error("unexpected outbound fetch"); }) as unknown as typeof fetch;

const app = new Hono();
app.route("/api/stripe", stripeRoutes);
app.route("/api/events", claims);

const CREATOR = "0x" + "aa".repeat(20);
const SIGNER = "0x" + "f0".repeat(20);
const KEY = "0a".repeat(32);
const SERIES = "series-0001";

function noticeRead(over: Record<string, unknown> = {}): VersionedFeedRead {
  return {
    status: "found",
    bytes: new TextEncoder().encode(JSON.stringify({
      format: ORGANISER_NOTICE_FORMAT,
      address: CREATOR,
      organiserName: "Punk Pub Ltd",
      sharing: ["venue"],
      orderRetentionMonths: 6,
      confirmedAt: "2026-10-11T09:00:00.000Z",
      ...over,
    })),
    version: 0,
    scanClean: true,
  } as VersionedFeedRead;
}

let answer: () => Promise<VersionedFeedRead> = async () => noticeRead();
/** What the organiser's feed answers from now on; the gate's cache is dropped so it is read. */
function setAnswer(a: () => Promise<VersionedFeedRead>): void {
  answer = a;
  gate.__setNoticeGateForTests({ reader: async () => answer() });
}

beforeEach(() => {
  setAnswer(async () => noticeRead());
  noRings();
});

let seq = 0;
/** A recorded (#670) event, unregistered unless asked: the refusal after the mode check needs no chain. */
function liveEvent(opts: { registered?: boolean; recorded?: boolean; orderFields?: OrderField[] } = {}): string {
  const eventId = `e1000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
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
    ...(opts.orderFields ? { orderFields: opts.orderFields } : {}),
    series: [{
      seriesId: SERIES,
      name: "GA",
      description: "",
      totalSupply: 10,
      ...(opts.registered ? { onChainEventId: "0x" + "01".repeat(32), swarmManifestRef: "02".repeat(32) } : {}),
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
let boxSeq = 0;
const freshBox = () => ({ v: 2, enc: "ab".repeat(1120), ct: (++boxSeq).toString(16).padStart(2, "0").repeat(64) });
const checkout = (eventId: string, marketing: unknown, box = freshBox()) =>
  post("/api/stripe/create-checkout", {
    eventId, seriesId: SERIES, claimerEmail: "a@example.com", encryptedOrder: box, encryptionKeyRef: KEY,
    ...(marketing === undefined ? {} : { marketing }),
  });
const status = async (eventId: string) => {
  const res = await app.request(`/api/events/${eventId}/series/${SERIES}/claim-status`);
  return { status: res.status, json: (await res.json()) as { ok: boolean; data?: Record<string, unknown> } };
};

/** What the page renders for these questions - the same function create-checkout rebuilds with. */
const words = (mode: MarketingMode, fields: OrderField[] = [], organiser = "Punk Pub Ltd") =>
  marketingWording(mode, 2, organiser, listKeeps(fields))!;
const consentChoice = (ticked = false, fields: OrderField[] = []) =>
  ({ mode: "consent", ticked, version: 2, surface: "order-form", wording: words("consent", fields) });
const ownChoice = (ticked = false, fields: OrderField[] = [], organiser = "Punk Pub Ltd") =>
  ({ mode: "own-events", ticked, version: 2, surface: "pay-panel", wording: words("own-events", fields, organiser) });

// ── claim-status ────────────────────────────────────────────────────────────

test("claim-status returns the mode the confirmed notice sets, and the name the sentence uses", async () => {
  setAnswer(async () => noticeRead({ marketingBasis: "own-events" }));
  const own = await status(liveEvent({ registered: true }));
  assert.equal(own.status, 200);
  assert.equal(own.json.data?.marketingMode, "own-events");
  assert.equal(own.json.data?.marketingOrganiser, "Punk Pub Ltd");
  assert.equal(own.json.data?.available, 10, "availability is still answered");
});

test("claim-status: a notice without a basis is consent mode, never the draft default", async () => {
  const r = await status(liveEvent({ registered: true }));
  assert.equal(r.json.data?.marketingMode, "consent");
});

test("claim-status: no confirmed notice, or none readable, omits the mode and still answers availability", async () => {
  for (const a of [
    async () => ({ status: "absent" }) as VersionedFeedRead,
    async () => { throw new Error("bee down"); },
  ]) {
    setAnswer(a);
    const r = await status(liveEvent({ registered: true }));
    assert.equal(r.status, 200);
    assert.equal(r.json.data?.marketingMode, undefined);
    assert.equal(r.json.data?.available, 10);
  }
  const legacy = await status(liveEvent({ registered: true, recorded: false }));
  assert.equal(legacy.json.data?.marketingMode, undefined);
});

// ── create-checkout ─────────────────────────────────────────────────────────

test("a page that showed the other mode is refused 409 MARKETING_MODE_CHANGED, with nothing held or charged", async () => {
  await readyAttendeeStore();
  setAnswer(async () => noticeRead({ marketingBasis: "own-events" }));
  const box = freshBox();
  const r = await checkout(liveEvent(), consentChoice(false), box);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, MARKETING_MODE_CHANGED);
  assert.equal(held.getHeldOrder(await writer.orderRefOf(canonicalOrderBox(box)!)), null, "nothing held");

  setAnswer(async () => noticeRead());
  const back = await checkout(liveEvent(), ownChoice(false));
  assert.equal(back.status, 409);
  assert.equal(back.json.code, MARKETING_MODE_CHANGED);
});

test("the matching mode, in either mode, passes on to the next check", async () => {
  await readyAttendeeStore();
  setAnswer(async () => noticeRead({ marketingBasis: "own-events" }));
  const own = await checkout(liveEvent(), ownChoice(true));
  assert.equal(own.status, 409);
  assert.match(String(own.json.error), /not currently on sale/);
  setAnswer(async () => noticeRead());
  const consent = await checkout(liveEvent(), consentChoice(true));
  assert.match(String(consent.json.error), /not currently on sale/);
});

const QUESTIONS: OrderField[] = [
  { id: "n", type: "text", label: "Full name", required: true },
  { id: "t", type: "text", label: "Town", required: false },
  { id: "a", type: "text", label: "Allergies", required: false, health: true },
];

test("a page whose words differ from the ones rebuilt here is refused 409 MARKETING_WORDING_CHANGED, with nothing held", async () => {
  await readyAttendeeStore();
  setAnswer(async () => noticeRead({ marketingBasis: "own-events" }));
  const cases: [string, unknown][] = [
    ["older questions", ownChoice(false, [QUESTIONS[0]!])],
    ["no questions named", ownChoice(false, [])],
    ["an older organiser name", ownChoice(false, QUESTIONS, "Old Pub Ltd")],
    ["no words at all (a page from before 2026-10-15)", { mode: "own-events", ticked: false, version: 2, surface: "embed" }],
    ["an older version", { ...ownChoice(false, QUESTIONS), version: 1, wording: { sentence: "We'll email you about similar events from Punk Pub Ltd. You can unsubscribe from any email.", box: "Don't email me about similar events" } }],
    ["today's words under an older version number", { ...ownChoice(false, QUESTIONS), version: 1 }],
    ["words edited on the page", { ...ownChoice(false, QUESTIONS), wording: { ...words("own-events", QUESTIONS), sentence: "We'll email you sometimes." } }],
  ];
  for (const [why, choice] of cases) {
    const box = freshBox();
    const r = await checkout(liveEvent({ orderFields: QUESTIONS }), choice, box);
    assert.equal(r.status, 409, why);
    assert.equal(r.json.code, MARKETING_WORDING_CHANGED, why);
    assert.equal(held.getHeldOrder(await writer.orderRefOf(canonicalOrderBox(box)!)), null, `${why}: nothing held`);
  }
  // Consent mode names no organiser, but names the questions all the same.
  setAnswer(async () => noticeRead());
  const stale = await checkout(liveEvent({ orderFields: QUESTIONS }), consentChoice(true, []));
  assert.equal(stale.json.code, MARKETING_WORDING_CHANGED);
});

test("the words rebuilt from the event's own questions pass on to the next check, in either mode", async () => {
  await readyAttendeeStore();
  setAnswer(async () => noticeRead({ marketingBasis: "own-events" }));
  const own = await checkout(liveEvent({ orderFields: QUESTIONS }), ownChoice(false, QUESTIONS));
  assert.match(String(own.json.error), /not currently on sale/);
  setAnswer(async () => noticeRead());
  const consent = await checkout(liveEvent({ orderFields: QUESTIONS }), consentChoice(true, QUESTIONS));
  assert.match(String(consent.json.error), /not currently on sale/);
  assert.match(words("consent", QUESTIONS).box, /We'll keep your email, name and your answers to: Town for this\./);
});

test("no control shown: nothing to compare, nothing recorded - the sale goes on", async () => {
  await readyAttendeeStore();
  setAnswer(async () => noticeRead({ marketingBasis: "own-events" }));
  const r = await checkout(liveEvent(), undefined);
  assert.match(String(r.json.error), /not currently on sale/);
});

test("a malformed choice is a 400, before any read", async () => {
  for (const bad of [
    { ...ownChoice(), version: 9 },
    { ...ownChoice(), surface: "agent" },
    { ...ownChoice(), ticked: "no" },
    { ...ownChoice(), wording: "We'll email you" },
    "own-events",
  ]) {
    const r = await checkout(liveEvent(), bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
});

test("the mode check sits after the notice gate and before the hold and the session", () => {
  const src = readFileSync(new URL("../src/routes/stripe.ts", import.meta.url), "utf-8");
  const at = src.indexOf("MARKETING_MODE_CHANGED },");
  assert.ok(at > 0);
  assert.ok(src.indexOf("noticeRefusal(noticeVerdictOf(notice))") < at);
  assert.ok(at < src.indexOf("commitHold(preparedRef"));
  assert.ok(at < src.indexOf("checkout.sessions.create("));
  // The wording check right after it, rebuilt from the event's questions, and its hash carried.
  const words = src.indexOf("MARKETING_WORDING_CHANGED },");
  assert.ok(at < words && words < src.indexOf("commitHold(preparedRef"));
  assert.match(src, /marketingWording\(marketing\.mode, current, organiserName, listKeeps\(event\.orderFields\)\)/);
  assert.match(src, /\.\.\.marketingMetadata\(marketing, organiserName, marketingHash\),/);
});

// ── The metadata ────────────────────────────────────────────────────────────

test("the metadata carries mode, the buyer's box, the wording version, the surface and the words' hash - never the words", () => {
  const hash = marketingWordingHash(words("own-events", QUESTIONS));
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    marketingMetadata({ mode: "own-events", ticked: false, version: 2, surface: "embed", wording: words("own-events", QUESTIONS) }, "Punk Pub Ltd", hash),
    { marketingMode: "own-events", marketingTicked: "0", marketingVersion: "2", marketingSurface: "embed", marketingOrganiser: "Punk Pub Ltd", marketingWordingHash: hash },
  );
  assert.deepEqual(
    marketingMetadata({ mode: "consent", ticked: true, version: 2, surface: "order-form" }, "Punk Pub Ltd", undefined),
    { marketingMode: "consent", marketingTicked: "1", marketingVersion: "2", marketingSurface: "order-form" },
  );
  assert.deepEqual(marketingMetadata(undefined, "Punk Pub Ltd", hash), {}, "no control shown: no keys");
  for (const choice of [
    { mode: "own-events", ticked: true, version: 2, surface: "pay-panel" },
    { mode: "consent", ticked: false, version: 2, surface: "embed" },
  ] as const) {
    const back = marketingFromMetadata(marketingMetadata(choice, "P", hash));
    assert.deepEqual(back?.choice, choice, "round trip");
    assert.equal(back?.wordingHash, hash);
  }
  // A hash names the exact words: any other question, name or version is another hash.
  assert.notEqual(marketingWordingHash(words("own-events", [QUESTIONS[0]!])), hash);
  assert.notEqual(marketingWordingHash(words("own-events", QUESTIONS, "Other")), hash);
  assert.equal(marketingFromMetadata({}), undefined);
  assert.equal(marketingFromMetadata(null), undefined);
});

test("the integrity tag commits to the marketing keys: flipping the box after creation reads as tampered", () => {
  const metadata = { eventId: "e", ...marketingMetadata({ mode: "own-events", ticked: true, version: 2, surface: "embed" }, "P", "cd".repeat(32)) };
  const fields = { account: "acct_1", currency: "gbp", amountSubtotal: 1000, amountTotal: 1000, applicationFee: 15, metadata };
  const tag = signCheckoutTag(fields);
  assert.ok(verifyCheckoutTag(tag, fields));
  assert.equal(verifyCheckoutTag(tag, { ...fields, metadata: { ...metadata, marketingTicked: "0" } }), false);
  assert.equal(verifyCheckoutTag(tag, { ...fields, metadata: { ...metadata, marketingMode: "consent" } }), false);
  assert.equal(verifyCheckoutTag(tag, { ...fields, metadata: { ...metadata, marketingWordingHash: "ef".repeat(32) } }), false);
});
