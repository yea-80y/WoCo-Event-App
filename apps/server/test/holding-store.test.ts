/**
 * Ticket receipts held for collection (lib/holding/store.ts) and keeping them
 * (lib/holding/keep.ts): woco-ops/spec-receipt-note-20261123.md 5.2-5.3.
 *
 * Pinned: a request is write-once and its pickup id unique; the box is sealed to the
 * order's pickup key and stored on the attendee batch as the BUYER's (kind "holding",
 * 12 months, never filed under the organiser) under the root the email link names; the
 * local copy goes once stored and a failed store is retried; an unreadable record is
 * never overwritten; the sweep drops only what is no longer owed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.chdir(mkdtempSync(join(tmpdir(), "woco-holding-store-")));
process.env.BEE_URL = "http://127.0.0.1:1";
process.env.EMAIL_HASH_SECRET ??= "0".repeat(64);
process.env.FEED_PRIVATE_KEY ??= "11".repeat(32);
globalThis.fetch = (async () => {
  throw new Error("bee unreachable");
}) as unknown as typeof fetch;

const { sealBox, sealBoxJson, openBoxJson, holdingBoxSealContext, holdingSecretSealContext } = await import("@woco/shared/crypto/sealed-box");
const { holdingPublicValues, holdingPickupKem } = await import("@woco/shared/holding/derive");
const { signTicketHolding, recoverTicketHoldingSigner } = await import("@woco/shared/holding/receipt");
const { parseHoldingKeepFragment } = await import("@woco/shared/holding/pickup");
const { parseHoldingBox } = await import("@woco/shared/holding/box");
const { parseHoldingRequest } = await import("@woco/shared/holding/request");
const store = await import("../src/lib/holding/store.js");
const { keepHoldingReceipts, retryUnstoredHoldings } = await import("../src/lib/holding/keep.js");
const ledger = await import("../src/lib/attendee-batch/ledger.js");
const writer = await import("../src/lib/attendee-batch/writer.js");
const { recordEventFeedSigner } = await import("../src/lib/event/feed-signer-record.js");
const { readyAttendeeStore, acceptingUploadChunk } = await import("./helpers/attendee-store.js");
const { Wallet } = await import("ethers");

const EVENT = "ev-holding";
const SERIES = "series-1";
const ACCOUNT = "0x" + "a1".repeat(20);
const TARGET = { chainId: 42161, ledger: "0x" + "c3".repeat(20) };
const ON_CHAIN = "0x" + "ab".repeat(32);
recordEventFeedSigner(EVENT, "0x" + "fe".repeat(20), "0x" + "4b".repeat(20));
await readyAttendeeStore();

const storeDeps = { stamper: writer.getAttendeeStamper, upload: async (e: unknown, b: Uint8Array) => (await acceptingUploadChunk(e, b)).reference.toHex() };
const storing = { store: (data: string | Uint8Array, meta: Parameters<typeof writer.storeAttendeePayload>[1]) => writer.storeAttendeePayload(data, meta, storeDeps as never), now: () => Date.now() };
const failing = { store: async () => { throw new Error("bee down"); }, now: () => Date.now() };

let sessions = 0;
const nextSession = () => `cs_test_holding${String(++sessions).padStart(8, "0")}`;

async function requestFrom(seed: number, n: number) {
  const r = new Uint8Array(32).fill(seed);
  const pv = holdingPublicValues(r, n);
  const accountKey = holdingPickupKem(new Uint8Array(32).fill(200)).publicKey;
  const sealedR = await sealBox(accountKey, r, holdingSecretSealContext(pv.pickupId));
  const raw = {
    v: 1, holders: pv.holders, answerKeys: pv.answerKeys, nkCommit: pv.nkCommit, pickupId: pv.pickupId,
    pickupSigner: pv.pickupSigner, pickupPub: Buffer.from(pv.pickupPub).toString("hex"), sealedR,
  };
  return { r, pv, request: parseHoldingRequest(raw, n)! };
}

function signedReceipts(pv: ReturnType<typeof holdingPublicValues>) {
  return pv.holders.map((holder, i) => {
    const burner = Wallet.createRandom();
    const holding = { eventId: ON_CHAIN, slot: 10 + i, holder, answerKey: pv.answerKeys[i]!, nkCommit: pv.nkCommit };
    return { holding, sig: signTicketHolding(TARGET, holding, Buffer.from(burner.privateKey.slice(2), "hex")), burner: burner.address.toLowerCase() };
  });
}

test("a request is write-once, by session; a pickup id belongs to one sale", async () => {
  const { request } = await requestFrom(1, 2);
  const s = nextSession();
  assert.equal(store.recordHoldingRequest({ sessionId: s, eventId: EVENT, seriesId: SERIES, account: ACCOUNT.toUpperCase().replace("0X", "0x"), request }), true);
  const rec = store.getHolding(s)!;
  assert.equal(rec.keep, "account");
  assert.equal(rec.account, ACCOUNT);
  assert.equal(rec.issued, undefined);
  assert.equal(store.holdingByPickupId(request.pickupId)?.sessionId, s);
  const other = await requestFrom(2, 2);
  assert.equal(store.recordHoldingRequest({ sessionId: s, eventId: EVENT, seriesId: SERIES, account: ACCOUNT, request: other.request }), true);
  assert.equal(store.getHolding(s)!.pickupId, request.pickupId, "the first request wins");
  assert.equal(store.recordHoldingRequest({ sessionId: nextSession(), eventId: EVENT, seriesId: SERIES, account: ACCOUNT, request }), false, "a reused pickup id is refused");
  assert.equal(store.recordHoldingRequest({ sessionId: "not-a-session", eventId: EVENT, seriesId: SERIES, account: ACCOUNT, request: other.request }), false);
  assert.deepEqual(store.holdingsForAccount(ACCOUNT).map((x) => x.sessionId), [s]);
});

test("a guest's receipts: sealed to the pickup key, stored as the buyer's on the attendee batch, under the root the link names", async () => {
  const r = new Uint8Array(32).fill(9);
  const pv = holdingPublicValues(r, 2);
  const receipts = signedReceipts(pv);
  const s = nextSession();
  const kept = await keepHoldingReceipts({
    sessionId: s, eventId: EVENT, seriesId: SERIES, target: TARGET,
    receipts: receipts.map(({ holding, sig }) => ({ holding, sig })),
    pickupId: pv.pickupId, pickupPub: Buffer.from(pv.pickupPub).toString("hex"), emailHash: "ee".repeat(32),
    guest: { r, holders: pv.holders, answerKeys: pv.answerKeys, nkCommit: pv.nkCommit, pickupSigner: pv.pickupSigner },
  }, storing);
  assert.ok(kept?.keepUrl);
  const parsed = parseHoldingKeepFragment(kept!.keepUrl!.slice(kept!.keepUrl!.indexOf("#")));
  assert.deepEqual(parsed, { r, boxRoot: kept!.boxRoot });

  const rec = store.getHolding(s)!;
  assert.equal(rec.keep, "email");
  assert.equal(rec.sealedR, undefined);
  assert.deepEqual(rec.issued?.slots, [10, 11]);
  assert.equal(rec.issued?.boxRoot, kept!.boxRoot);
  assert.equal(rec.issued?.box, undefined, "the local copy goes once stored");
  assert.ok(rec.issued?.storedAt);
  assert.equal(JSON.stringify(rec).includes(Buffer.from(r).toString("hex")), false, "the secret is never in the record");

  const order = ledger.getOrderRecord(kept!.boxRoot)!;
  assert.equal(order.kind, "holding");
  assert.equal(order.retainMonths, 12);
  assert.equal(order.emailHash, "ee".repeat(32));
  assert.equal(order.organiser, undefined, "never filed under the organiser");
  assert.equal(order.state, "stored");
});

test("the stored box opens only with the order's pickup key and holds verifiable receipts", async () => {
  const r = new Uint8Array(32).fill(11);
  const pv = holdingPublicValues(r, 1);
  const receipts = signedReceipts(pv);
  const s = nextSession();
  const pickupPub = Buffer.from(pv.pickupPub).toString("hex");
  // Fail the store so the record keeps the sealed box to read back here.
  const kept = await keepHoldingReceipts({
    sessionId: s, eventId: EVENT, seriesId: SERIES, target: TARGET,
    receipts: receipts.map(({ holding, sig }) => ({ holding, sig })), pickupId: pv.pickupId, pickupPub,
    guest: { r, holders: pv.holders, answerKeys: pv.answerKeys, nkCommit: pv.nkCommit, pickupSigner: pv.pickupSigner },
  }, failing);
  const sealed = store.getHolding(s)!.issued!.box!;
  assert.equal(await writer.orderRefOf(JSON.stringify(sealed)), kept!.boxRoot, "the link's root is the sealed box's /bytes root");
  const box = parseHoldingBox(await openBoxJson(holdingPickupKem(r).secretKey, sealed, holdingBoxSealContext(pv.pickupId)))!;
  assert.equal(box.receipts.length, 1);
  const e = box.receipts[0]!;
  assert.equal(recoverTicketHoldingSigner({ chainId: e.chainId, ledger: e.ledger }, e, e.sig), receipts[0]!.burner);
  assert.equal(e.edition, 11);
  assert.equal(e.wocoEventId, EVENT);
  await assert.rejects(openBoxJson(holdingPickupKem(new Uint8Array(32).fill(12)).secretKey, sealed, holdingBoxSealContext(pv.pickupId)));
});

test("a failed store is retried; health is red only after an hour", async () => {
  const r = new Uint8Array(32).fill(13);
  const pv = holdingPublicValues(r, 1);
  const s = nextSession();
  const issuedAt = Date.now();
  await keepHoldingReceipts({
    sessionId: s, eventId: EVENT, seriesId: SERIES, target: TARGET,
    receipts: signedReceipts(pv).map(({ holding, sig }) => ({ holding, sig })), pickupId: pv.pickupId, pickupPub: Buffer.from(pv.pickupPub).toString("hex"),
    guest: { r, holders: pv.holders, answerKeys: pv.answerKeys, nkCommit: pv.nkCommit, pickupSigner: pv.pickupSigner },
  }, failing);
  assert.ok(store.unstoredHoldings().some((x) => x.sessionId === s));
  assert.equal(store.holdingReceiptsHealth(issuedAt + 59 * 60_000).unstoredOverAnHour, 0);
  assert.equal(store.holdingReceiptsHealth(issuedAt + 61 * 60_000).ok, false);
  const out = await retryUnstoredHoldings(20, storing);
  assert.ok(out.stored >= 1);
  assert.equal(store.unstoredHoldings().some((x) => x.sessionId === s), false);
  assert.equal(store.getHolding(s)!.issued!.box, undefined);
  assert.equal(ledger.getOrderRecord(store.getHolding(s)!.issued!.boxRoot)?.kind, "holding");
});

test("a signed-in buyer's request is completed at fulfilment, write-once, with no link", async () => {
  const { pv, request } = await requestFrom(21, 2);
  const s = nextSession();
  store.recordHoldingRequest({ sessionId: s, eventId: EVENT, seriesId: SERIES, account: ACCOUNT, request });
  const receipts = signedReceipts(pv).map(({ holding, sig }) => ({ holding, sig }));
  const kept = await keepHoldingReceipts({ sessionId: s, eventId: EVENT, seriesId: SERIES, target: TARGET, receipts, pickupId: request.pickupId, pickupPub: request.pickupPub }, storing);
  assert.equal(kept?.keepUrl, undefined);
  const rec = store.getHolding(s)!;
  assert.equal(rec.keep, "account");
  assert.ok(rec.sealedR);
  assert.equal(rec.issued?.boxRoot, kept!.boxRoot);
  // A second keep for the same sale changes nothing, and is "recorded" only for the same box.
  assert.equal(store.recordHoldingIssued({ sessionId: s, eventId: EVENT, seriesId: SERIES, issued: { ...rec.issued!, boxRoot: "00".repeat(32) } }), false);
  assert.equal(store.recordHoldingIssued({ sessionId: s, eventId: EVENT, seriesId: SERIES, issued: rec.issued! }), true);
  assert.equal(store.getHolding(s)!.issued!.boxRoot, kept!.boxRoot);
});

test("a guest keep that meets another order's request for the same sale is refused: no link", async () => {
  const { request } = await requestFrom(23, 1);
  const s = nextSession();
  store.recordHoldingRequest({ sessionId: s, eventId: EVENT, seriesId: SERIES, account: ACCOUNT, request });
  const r = new Uint8Array(32).fill(24);
  const pv = holdingPublicValues(r, 1);
  const kept = await keepHoldingReceipts({
    sessionId: s, eventId: EVENT, seriesId: SERIES, target: TARGET,
    receipts: signedReceipts(pv).map(({ holding, sig }) => ({ holding, sig })), pickupId: pv.pickupId, pickupPub: Buffer.from(pv.pickupPub).toString("hex"),
    guest: { r, holders: pv.holders, answerKeys: pv.answerKeys, nkCommit: pv.nkCommit, pickupSigner: pv.pickupSigner },
  }, storing);
  assert.equal(kept, null);
  assert.equal(store.getHolding(s)!.issued, undefined);
  assert.equal(store.getHolding(s)!.pickupId, request.pickupId);
});

test("no receipts, or nothing recorded: no link", async () => {
  const r = new Uint8Array(32).fill(31);
  const pv = holdingPublicValues(r, 1);
  const base = { eventId: EVENT, seriesId: SERIES, target: TARGET, pickupId: pv.pickupId, pickupPub: Buffer.from(pv.pickupPub).toString("hex") };
  assert.equal(await keepHoldingReceipts({ ...base, sessionId: nextSession(), receipts: [] }, storing), null);
  // A signed-in sale whose request was never recorded: nothing to complete, no record, no link.
  assert.equal(await keepHoldingReceipts({ ...base, sessionId: nextSession(), receipts: signedReceipts(pv).map(({ holding, sig }) => ({ holding, sig })) }, storing), null);
});

test("an unreadable record is never overwritten, and alarms", async () => {
  const { request } = await requestFrom(41, 1);
  const s = nextSession();
  const file = join(process.cwd(), ".data", "holding-receipts", `${s}.json`);
  writeFileSync(file, "{ not json", { mode: 0o600 });
  store._resetHoldingStoreForTests();
  assert.equal(store.recordHoldingRequest({ sessionId: s, eventId: EVENT, seriesId: SERIES, account: ACCOUNT, request }), false);
  assert.equal(readFileSync(file, "utf-8"), "{ not json");
  assert.equal(store.holdingReceiptsHealth().ok, false);
  assert.ok(store.holdingReceiptsHealth().unreadable >= 1);
  store.deleteHolding(s);
  assert.equal(store.holdingReceiptsHealth().unreadable, 0);
});

test("after a restart, records and pickup ids are found again from disk", async () => {
  const { request } = await requestFrom(51, 1);
  const s = nextSession();
  store.recordHoldingRequest({ sessionId: s, eventId: EVENT, seriesId: SERIES, account: ACCOUNT, request });
  store._resetHoldingStoreForTests();
  assert.equal(store.holdingByPickupId(request.pickupId)?.sessionId, s);
  assert.ok(store.holdingsForAccount(ACCOUNT).some((x) => x.sessionId === s));
});

test("the sweep drops an unpaid request after a day and a record whose box was erased - nothing else", async () => {
  const now = Date.now();
  const unpaid = await requestFrom(61, 1);
  const sUnpaid = nextSession();
  store.recordHoldingRequest({ sessionId: sUnpaid, eventId: EVENT, seriesId: SERIES, account: ACCOUNT, request: unpaid.request, now: now - store.HOLDING_REQUEST_TTL_MS - 1000 });
  const fresh = await requestFrom(62, 1);
  const sFresh = nextSession();
  store.recordHoldingRequest({ sessionId: sFresh, eventId: EVENT, seriesId: SERIES, account: ACCOUNT, request: fresh.request, now });
  const r = new Uint8Array(32).fill(63);
  const pv = holdingPublicValues(r, 1);
  const sErased = nextSession();
  const kept = await keepHoldingReceipts({
    sessionId: sErased, eventId: EVENT, seriesId: SERIES, target: TARGET,
    receipts: signedReceipts(pv).map(({ holding, sig }) => ({ holding, sig })), pickupId: pv.pickupId, pickupPub: Buffer.from(pv.pickupPub).toString("hex"),
    guest: { r, holders: pv.holders, answerKeys: pv.answerKeys, nkCommit: pv.nkCommit, pickupSigner: pv.pickupSigner },
  }, storing);
  const erased = new Set([kept!.boxRoot]);
  store.sweepHoldings((root) => erased.has(root), now);
  assert.equal(store.getHolding(sUnpaid), null);
  assert.ok(store.getHolding(sFresh));
  assert.equal(store.getHolding(sErased), null);
  assert.equal(store.holdingByPickupId(pv.pickupId), null);
});

// ── Fable sign-off conditions (2026-11-24) ──────────────────────────────────

function guestInput(seed: number) {
  const r = new Uint8Array(32).fill(seed);
  const pv = holdingPublicValues(r, 1);
  return {
    sessionId: nextSession(), eventId: EVENT, seriesId: SERIES, target: TARGET,
    receipts: signedReceipts(pv).map(({ holding, sig }) => ({ holding, sig })), pickupId: pv.pickupId, pickupPub: Buffer.from(pv.pickupPub).toString("hex"),
    guest: { r, holders: pv.holders, answerKeys: pv.answerKeys, nkCommit: pv.nkCommit, pickupSigner: pv.pickupSigner },
  };
}

test("a box erased before its upload landed is never retried, and the sweep drops it", async () => {
  const input = guestInput(71);
  const kept = await keepHoldingReceipts(input, failing);
  const json = JSON.stringify(store.getHolding(input.sessionId)!.issued!.box);
  ledger.recordErasedBeforeStore(kept!.boxRoot, { eventId: EVENT });
  const seen: string[] = [];
  await retryUnstoredHoldings(100, { store: (d, m) => (seen.push(String(d)), storing.store(d, m)), now: () => Date.now() });
  assert.equal(seen.includes(json), false, "never sent to the batch");
  store.sweepHoldings(ledger.isOrderErased);
  assert.equal(store.getHolding(input.sessionId), null, "its local copy goes");
});

test("the email waits at most the store wait; a late store still lands; the retry never stores it twice at once", async () => {
  await retryUnstoredHoldings(100, storing);
  const input = guestInput(72);
  const seen: string[] = [];
  let release!: () => void;
  let first = true;
  const slow = {
    store: (d: string | Uint8Array, m: Parameters<typeof storing.store>[1]) => {
      seen.push(String(d));
      if (!first) return storing.store(d, m);
      first = false;
      return new Promise<string>((resolve, reject) => {
        release = () => void storing.store(d, m).then(resolve, reject);
      });
    },
    now: () => Date.now(),
    storeWaitMs: 20,
  };
  const t0 = Date.now();
  const kept = await keepHoldingReceipts(input, slow as never);
  assert.ok(Date.now() - t0 < 2_000, "the email did not wait for the batch");
  assert.ok(kept?.keepUrl, "the link needs no upload");
  const json = JSON.stringify(store.getHolding(input.sessionId)!.issued!.box);
  await retryUnstoredHoldings(100, slow as never);
  assert.equal(seen.filter((d) => d === json).length, 1, "the retry left the box being stored alone");
  release();
  for (let i = 0; i < 200 && store.getHolding(input.sessionId)!.issued!.box; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(store.getHolding(input.sessionId)!.issued!.box, undefined, "the late store landed");
  assert.ok(store.getHolding(input.sessionId)!.issued!.storedAt);
});

test("one retry pass at a time", async () => {
  // Two boxes waiting: a second pass while the first is still busy with one must not take the other.
  const input = guestInput(73);
  await keepHoldingReceipts(input, failing);
  const other = guestInput(75);
  await keepHoldingReceipts(other, failing);
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const gated = { store: async (d: string | Uint8Array, m: Parameters<typeof storing.store>[1]) => (await gate, storing.store(d, m)), now: () => Date.now() };
  const first = retryUnstoredHoldings(100, gated as never);
  // Bounded, so a missing guard fails here instead of hanging on the closed gate.
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  const second = await Promise.race([
    retryUnstoredHoldings(100, gated as never),
    new Promise((r) => (giveUp = setTimeout(() => r("a second pass started"), 1_000))),
  ]).finally(() => clearTimeout(giveUp));
  assert.deepEqual(second, { stored: 0, failed: 0 });
  open();
  assert.ok((await first).stored >= 2);
  assert.equal(store.getHolding(input.sessionId)!.issued!.box, undefined);
  assert.equal(store.getHolding(other.sessionId)!.issued!.box, undefined);
});

test("an unpaid request outlives a Stripe session's day (a late webhook still finds it), then goes", async () => {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const late = await requestFrom(90, 1);
  const sLate = nextSession();
  store.recordHoldingRequest({ sessionId: sLate, eventId: EVENT, seriesId: SERIES, account: ACCOUNT, request: late.request, now: now - 30 * hour });
  const old = await requestFrom(91, 1);
  const sOld = nextSession();
  store.recordHoldingRequest({ sessionId: sOld, eventId: EVENT, seriesId: SERIES, account: ACCOUNT, request: old.request, now: now - 49 * hour });
  store.sweepHoldings(() => false, now);
  assert.ok(store.getHolding(sLate), "30 h: kept");
  assert.equal(store.getHolding(sOld), null, "49 h: gone");
});

test("a box that does not hash to its recorded root is never uploaded", async () => {
  const r = new Uint8Array(32).fill(74);
  const pv = holdingPublicValues(r, 1);
  const s = nextSession();
  const box = await sealBoxJson(Buffer.from(pv.pickupPub).toString("hex"), { v: 1, receipts: [] }, holdingBoxSealContext(pv.pickupId));
  store.recordHoldingIssued({
    sessionId: s, eventId: EVENT, seriesId: SERIES,
    guest: { holders: pv.holders, answerKeys: pv.answerKeys, nkCommit: pv.nkCommit, pickupId: pv.pickupId, pickupSigner: pv.pickupSigner, pickupPub: Buffer.from(pv.pickupPub).toString("hex") },
    issued: { chainId: TARGET.chainId, ledger: TARGET.ledger, onChainEventId: ON_CHAIN, slots: [1], boxRoot: "11".repeat(32), box },
  });
  const seen: string[] = [];
  await retryUnstoredHoldings(100, { store: (d, m) => (seen.push(String(d)), storing.store(d, m)), now: () => Date.now() });
  assert.equal(seen.includes(JSON.stringify(box)), false);
  assert.ok(store.getHolding(s)!.issued!.box, "kept for an operator, never stored");
  store.deleteHolding(s);
});

test("unpaid requests are capped: the oldest makes room", async () => {
  store._setMaxUnpaidRequestsForTests(2);
  try {
    const t = Date.now();
    const ids: string[] = [];
    for (let k = 0; k < 3; k++) {
      const { request } = await requestFrom(80 + k, 1);
      const s = nextSession();
      ids.push(s);
      assert.equal(store.recordHoldingRequest({ sessionId: s, eventId: EVENT, seriesId: SERIES, account: ACCOUNT, request, now: t + k }), true);
    }
    assert.equal(store.getHolding(ids[0]!), null, "the oldest unpaid went");
    assert.ok(store.getHolding(ids[1]!));
    assert.ok(store.getHolding(ids[2]!));
  } finally {
    store._setMaxUnpaidRequestsForTests(5_000);
  }
});

// ── Before the flag flips (spec 13a items 2-4) ──────────────────────────────

test("one key, one sale: any value another sale owns is refused, in any role; freed when that sale goes", async () => {
  const a = await requestFrom(101, 2);
  const sA = nextSession();
  assert.equal(store.recordHoldingRequest({ sessionId: sA, eventId: EVENT, seriesId: SERIES, account: ACCOUNT, request: a.request }), true);
  const b = await requestFrom(102, 2);
  const reuses: Array<[string, typeof b.request]> = [
    ["a holder", { ...b.request, holders: [a.request.holders[1]!, b.request.holders[1]!] }],
    ["an answer key", { ...b.request, answerKeys: [b.request.answerKeys[0]!, a.request.answerKeys[0]!] }],
    ["the pickup signer", { ...b.request, pickupSigner: a.request.pickupSigner }],
    ["the count-once commitment", { ...b.request, nkCommit: a.request.nkCommit }],
    ["a holder as an answer key", { ...b.request, answerKeys: [a.request.holders[0]!, b.request.answerKeys[1]!] }],
    ["the pickup signer as a holder", { ...b.request, holders: [a.request.pickupSigner, b.request.holders[1]!] }],
    ["the pickup id", { ...b.request, pickupId: a.request.pickupId }],
  ];
  for (const [what, request] of reuses) {
    const s = nextSession();
    assert.equal(store.recordHoldingRequest({ sessionId: s, eventId: EVENT, seriesId: SERIES, account: ACCOUNT, request }), false, what);
    assert.equal(store.getHolding(s), null, what);
  }
  // A guest record at fulfilment is held to the same rule.
  const g = holdingPublicValues(new Uint8Array(32).fill(103), 1);
  const sG = nextSession();
  assert.equal(store.recordHoldingIssued({
    sessionId: sG, eventId: EVENT, seriesId: SERIES,
    guest: { holders: [a.request.holders[0]!], answerKeys: g.answerKeys, nkCommit: g.nkCommit, pickupId: g.pickupId, pickupSigner: g.pickupSigner, pickupPub: Buffer.from(g.pickupPub).toString("hex") },
    issued: { chainId: TARGET.chainId, ledger: TARGET.ledger, onChainEventId: ON_CHAIN, slots: [1], boxRoot: "12".repeat(32) },
  }), false);
  assert.equal(store.getHolding(sG), null);
  // The untouched request of B still goes in; after A is deleted, A's values are free again.
  assert.equal(store.recordHoldingRequest({ sessionId: nextSession(), eventId: EVENT, seriesId: SERIES, account: ACCOUNT, request: b.request }), true);
  store.deleteHolding(sA);
  assert.equal(store.recordHoldingRequest({ sessionId: nextSession(), eventId: EVENT, seriesId: SERIES, account: ACCOUNT, request: a.request }), true);
});

test("the values a sale owns are found again after a restart", async () => {
  const a = await requestFrom(104, 1);
  store.recordHoldingRequest({ sessionId: nextSession(), eventId: EVENT, seriesId: SERIES, account: ACCOUNT, request: a.request });
  store._resetHoldingStoreForTests();
  const b = await requestFrom(105, 1);
  assert.equal(store.recordHoldingRequest({ sessionId: nextSession(), eventId: EVENT, seriesId: SERIES, account: ACCOUNT, request: { ...b.request, nkCommit: a.request.nkCommit } }), false);
});

test("a box root names one sale", async () => {
  const a = guestInput(106);
  const kept = await keepHoldingReceipts(a, failing);
  const g = holdingPublicValues(new Uint8Array(32).fill(107), 1);
  const s = nextSession();
  assert.equal(store.recordHoldingIssued({
    sessionId: s, eventId: EVENT, seriesId: SERIES,
    guest: { holders: g.holders, answerKeys: g.answerKeys, nkCommit: g.nkCommit, pickupId: g.pickupId, pickupSigner: g.pickupSigner, pickupPub: Buffer.from(g.pickupPub).toString("hex") },
    issued: { chainId: TARGET.chainId, ledger: TARGET.ledger, onChainEventId: ON_CHAIN, slots: [1], boxRoot: kept!.boxRoot },
  }), false);
  assert.equal(store.holdingByBoxRoot(kept!.boxRoot)?.sessionId, a.sessionId);
  assert.equal(store.holdingByBoxRoot("0x" + kept!.boxRoot.toUpperCase())?.sessionId, a.sessionId);
});

test("the buyer's erase drops what opens, finds or links the receipt, and keeps the public values", async () => {
  const { request } = await requestFrom(110, 2);
  const s = nextSession();
  store.recordHoldingRequest({ sessionId: s, eventId: EVENT, seriesId: SERIES, account: ACCOUNT, request });
  assert.equal(store.markHoldingErased(s), false, "nothing to erase before it is paid");
  const pv = holdingPublicValues(new Uint8Array(32).fill(110), 2);
  await keepHoldingReceipts({
    sessionId: s, eventId: EVENT, seriesId: SERIES, target: TARGET,
    receipts: signedReceipts(pv).map(({ holding, sig }) => ({ holding, sig })), pickupId: request.pickupId, pickupPub: request.pickupPub, emailHash: "e1".repeat(32),
  }, failing);
  const before = store.getHolding(s)!;
  assert.ok(before.issued!.box && before.sealedR && before.account && before.issued!.emailHash);

  const t = Date.parse("2026-11-24T12:00:00Z");
  assert.equal(store.markHoldingErased(s, t), true);
  const after = store.getHolding(s)!;
  assert.equal(after.erasedAt, new Date(t).toISOString());
  for (const gone of ["sealedR", "account"] as const) assert.equal(after[gone], undefined, gone);
  assert.equal(after.issued!.box, undefined);
  assert.equal(after.issued!.emailHash, undefined);
  // What a replacement re-signs over (spec 8), and where the box was.
  assert.deepEqual(after.holders, before.holders);
  assert.deepEqual(after.answerKeys, before.answerKeys);
  assert.equal(after.nkCommit, before.nkCommit);
  assert.equal(after.pickupPub, before.pickupPub);
  assert.equal(after.pickupId, before.pickupId);
  assert.deepEqual(after.issued!.slots, before.issued!.slots);
  assert.equal(after.issued!.boxRoot, before.issued!.boxRoot);

  assert.equal(store.markHoldingErased(s, t + 1), true, "idempotent");
  assert.equal(store.getHolding(s)!.erasedAt, new Date(t).toISOString());
  assert.equal(store.holdingsForAccount(ACCOUNT).some((x) => x.sessionId === s), false);
  assert.equal(store.holdingsForEmailHash("e1".repeat(32)).length, 0);
  assert.equal(store.unstoredHoldings().some((x) => x.sessionId === s), false, "never retried");
  assert.equal(store.markHoldingStored(s), true, "a store landing late adds nothing");
  assert.equal(store.getHolding(s)!.issued!.storedAt, undefined);

  // The minute sweep leaves it: its box is erased by construction, its values stay until the end.
  store.sweepHoldings(() => true);
  assert.ok(store.getHolding(s));
  // And the erased record reads back after a restart, still owning its values.
  store._resetHoldingStoreForTests();
  assert.ok(store.getHolding(s)!.erasedAt);
  const other = await requestFrom(111, 1);
  assert.equal(store.recordHoldingRequest({ sessionId: nextSession(), eventId: EVENT, seriesId: SERIES, account: ACCOUNT, request: { ...other.request, nkCommit: request.nkCommit } }), false);
  store.deleteHolding(s);
});

test("an erased record still carrying a secret, an account or a box is unreadable, never trusted", () => {
  const base = {
    v: 1, eventId: EVENT, seriesId: SERIES, createdAt: new Date().toISOString(), keep: "email", holders: ["0x" + "01".repeat(20)],
    answerKeys: ["0x" + "02".repeat(20)], nkCommit: "0x" + "03".repeat(32), pickupId: "04".repeat(32), pickupSigner: "0x" + "05".repeat(20),
    pickupPub: "06", erasedAt: new Date().toISOString(),
    issued: { chainId: 1, ledger: "0x" + "07".repeat(20), onChainEventId: ON_CHAIN, slots: [1], boxRoot: "08".repeat(32), issuedAt: new Date().toISOString() },
  };
  const box = { v: 2, kem: "aa", nonce: "bb", ct: "cc" };
  for (const bad of [
    { account: ACCOUNT },
    { sealedR: box },
    { issued: { ...base.issued, emailHash: "e2".repeat(32) } },
    { issued: undefined },
  ]) {
    const s = nextSession();
    writeFileSync(join(process.cwd(), ".data", "holding-receipts", `${s}.json`), JSON.stringify({ ...base, sessionId: s, ...bad }), { mode: 0o600 });
    store._resetHoldingStoreForTests();
    assert.throws(() => store.getHolding(s), /unreadable/, JSON.stringify(bad));
    store.deleteHolding(s);
  }
  const s = nextSession();
  writeFileSync(join(process.cwd(), ".data", "holding-receipts", `${s}.json`), JSON.stringify({ ...base, sessionId: s }), { mode: 0o600 });
  store._resetHoldingStoreForTests();
  assert.ok(store.getHolding(s)?.erasedAt, "the clean erased shape reads");
  store.deleteHolding(s);
});

test("each record on its own clock: 12 months after the on-chain end, the end itself once erased; every doubt keeps it", async () => {
  store._resetHoldingStoreForTests();
  const END = Date.parse("2026-12-01T00:00:00Z");
  const YEAR_ON = Date.parse("2027-12-01T00:00:00Z");
  const ON_A = "0x" + "a0".repeat(32);
  const ON_B = "0x" + "b0".repeat(32);
  const ON_C = "0x" + "c0".repeat(32);
  async function paid(seed: number, onChain: string) {
    const input = guestInput(seed);
    input.receipts = input.receipts.map(({ holding, sig }) => ({ holding: { ...holding, eventId: onChain }, sig }));
    await keepHoldingReceipts(input, failing);
    return input.sessionId;
  }
  const live = await paid(120, ON_A);
  const erased = await paid(121, ON_A);
  assert.equal(store.markHoldingErased(erased), true);
  const noEnd = await paid(122, ON_B);
  const rpcDown = await paid(123, ON_C);
  const unpaid = (await requestFrom(124, 1)).request;
  const sUnpaid = nextSession();
  store.recordHoldingRequest({ sessionId: sUnpaid, eventId: EVENT, seriesId: SERIES, account: ACCOUNT, request: unpaid });

  const endReads: string[] = [];
  const deps = (now: number, chainNow: number | Error) => ({
    now: () => now,
    chainNow: async () => {
      if (chainNow instanceof Error) throw chainNow;
      return chainNow;
    },
    chainEnd: async (r: { issued: { onChainEventId: string } }) => {
      endReads.push(r.issued.onChainEventId);
      if (r.issued.onChainEventId === ON_B) return null;
      if (r.issued.onChainEventId === ON_C) throw new Error("rpc down");
      return END;
    },
  });

  // Before the end: nothing goes, and the chain's clock is never asked.
  let clockReads = 0;
  let out = await store.sweepHoldingsDue({ ...deps(END - 1, END - 1), chainNow: async () => (clockReads++, END - 1) });
  assert.equal(out.removed, 0);
  assert.equal(out.endUnknown, 2);
  assert.equal(clockReads, 0, "no chain read for a record not due by our own clock");
  assert.equal(endReads.filter((x) => x === ON_A).length, 1, "one end read per event a pass");
  // At the end, but the chain's clock is behind ours: kept.
  out = await store.sweepHoldingsDue(deps(END + 1000, END - 1));
  assert.ok(store.getHolding(erased), "a fast server clock cannot delete early");
  // At the end, the chain's clock unreadable: kept.
  out = await store.sweepHoldingsDue(deps(END + 1000, new Error("no block")));
  assert.ok(store.getHolding(erased));
  // At the end: the erased record goes, the live one stays.
  out = await store.sweepHoldingsDue(deps(END + 1000, END + 1000));
  assert.equal(store.getHolding(erased), null);
  assert.ok(store.getHolding(live));
  // A day short of 12 months: kept. At 12 months: gone. No end on chain, or none readable: kept for good.
  await store.sweepHoldingsDue(deps(YEAR_ON - 86_400_000, YEAR_ON));
  assert.ok(store.getHolding(live));
  out = await store.sweepHoldingsDue(deps(YEAR_ON, YEAR_ON));
  assert.equal(store.getHolding(live), null);
  assert.ok(store.getHolding(noEnd));
  assert.ok(store.getHolding(rpcDown));
  assert.ok(store.getHolding(sUnpaid), "an unpaid request is the 48 h rule's, not this one's");
  assert.equal(store.holdingReceiptsHealth().due.endUnknown, 2);
  for (const s of [noEnd, rpcDown, sUnpaid]) store.deleteHolding(s);
});

test("a paid sale owed receipts that got none turns health red, and says why", () => {
  store._resetHoldingStoreForTests();
  assert.equal(store.holdingReceiptsHealth().ok, true);
  store.noteHoldingMissed(nextSession(), "2 of 2 receipts not signed", Date.parse("2026-11-24T10:00:00Z"));
  const h = store.holdingReceiptsHealth();
  assert.equal(h.ok, false);
  assert.equal(h.missed, 1);
  assert.deepEqual(h.lastMissed, { at: "2026-11-24T10:00:00.000Z", why: "2 of 2 receipts not signed" });
  store._resetHoldingStoreForTests();
});

test("the retry worker: an erased box never takes a slot of the pass, and one erased mid-pass is never sent", async () => {
  await retryUnstoredHoldings(1000, storing);
  assert.equal(store.unstoredHoldings().length, 0);
  const erasedFirst = guestInput(140);
  const next = guestInput(141);
  const keptErased = await keepHoldingReceipts(erasedFirst, failing);
  await keepHoldingReceipts(next, failing);
  ledger.recordErasedBeforeStore(keptErased!.boxRoot, { kind: "holding", eventId: EVENT });
  // A pass of one: the erased box (listed first) must not use it up.
  assert.equal((await retryUnstoredHoldings(1, storing)).stored, 1);
  assert.ok(store.getHolding(next.sessionId)!.issued!.storedAt);

  // Two waiting; the first one's store erases the second before its turn.
  const a = guestInput(142);
  const b = guestInput(143);
  await keepHoldingReceipts(a, failing);
  const keptB = await keepHoldingReceipts(b, failing);
  const bJson = JSON.stringify(store.getHolding(b.sessionId)!.issued!.box);
  const seen: string[] = [];
  const erasingMidPass = {
    store: async (d: string | Uint8Array, m: Parameters<typeof storing.store>[1]) => {
      seen.push(String(d));
      if (!ledger.getOrderRecord(keptB!.boxRoot)) ledger.recordErasedBeforeStore(keptB!.boxRoot, { kind: "holding", eventId: EVENT });
      return storing.store(d, m);
    },
    now: () => Date.now(),
  };
  await retryUnstoredHoldings(100, erasingMidPass);
  assert.equal(seen.includes(bJson), false, "read again before its store, and left alone");
  assert.ok(store.getHolding(a.sessionId)!.issued!.storedAt);
});

test("records by email hash: paid ones only", async () => {
  const input = { ...guestInput(130), emailHash: "e3".repeat(32) };
  await keepHoldingReceipts(input, failing);
  const unpaid = await requestFrom(131, 1);
  store.recordHoldingRequest({ sessionId: nextSession(), eventId: EVENT, seriesId: SERIES, account: ACCOUNT, request: unpaid.request });
  assert.deepEqual(store.holdingsForEmailHash("e3".repeat(32)).map((r) => r.sessionId), [input.sessionId]);
});
