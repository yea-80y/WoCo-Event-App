/**
 * `/api/holdings/*` (routes/holdings.ts) and what erasing a receipt box does to the
 * attendee batch, the ops erasure path and the organiser's orders view:
 * woco-ops/spec-receipt-note-20261123.md 5.1-5.3, 13a items 4-5.
 *
 * Pinned: off = every route refuses; the pickup id is read from the POST body only; the
 * box is served only while it is not yet on Swarm; an erase needs the order's pickup
 * signer inside the window, erases the attendee-batch copy (stored or not) and keeps the
 * public values; /mine answers by the verified account only; an erasure request by email
 * reaches a box not yet stored; no reader takes a receipt box for an organiser's order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { concat, keccak256, Wallet, type TypedDataEncoder } from "ethers";

process.chdir(mkdtempSync(join(tmpdir(), "woco-holding-routes-")));
const HOST = "test.woco.local";
process.env.ALLOWED_HOSTS = HOST;
process.env.BEE_URL = "http://127.0.0.1:1";
process.env.EMAIL_HASH_SECRET ??= "0".repeat(64);
process.env.FEED_PRIVATE_KEY ??= "11".repeat(32);
process.env.OPS_TOKEN = "t".repeat(40);
process.env.CHECKIN_PASS_SECRET ??= "test-door-pass-secret";
globalThis.fetch = (async () => {
  throw new Error("bee unreachable");
}) as unknown as typeof fetch;

const { FEATURES, SESSION_DOMAIN, SESSION_TYPES, SESSION_PURPOSE, SESSION_EXPIRY_MS } = await import("@woco/shared");
const { enableFeature } = await import("./helpers/features.js");
enableFeature("walletLoginAllowed");
const { holdingPublicValues, holdingPickupSigner } = await import("@woco/shared/holding/derive");
const { signErasePickup } = await import("@woco/shared/holding/pickup");
const { signTicketHolding } = await import("@woco/shared/holding/receipt");
const { sealBox, holdingSecretSealContext } = await import("@woco/shared/crypto/sealed-box");
const { holdingPickupKem } = await import("@woco/shared/holding/derive");
const { parseHoldingRequest } = await import("@woco/shared/holding/request");
const store = await import("../src/lib/holding/store.js");
const { keepHoldingReceipts, retryUnstoredHoldings } = await import("../src/lib/holding/keep.js");
const ledger = await import("../src/lib/attendee-batch/ledger.js");
const writer = await import("../src/lib/attendee-batch/writer.js");
const { eraseOrder } = await import("../src/lib/attendee-batch/erase.js");
const { ordersStatus } = await import("../src/lib/event/orders-status.js");
const { holdingsRoutes } = await import("../src/routes/holdings.js");
const { ops } = await import("../src/routes/ops.js");
const { recordEventFeedSigner } = await import("../src/lib/event/feed-signer-record.js");
const { readyAttendeeStore, acceptingUploadChunk } = await import("./helpers/attendee-store.js");

await readyAttendeeStore();
const EVENT = "ev-holding-routes";
const SERIES = "series-1";
const TARGET = { chainId: 42161, ledger: "0x" + "c3".repeat(20) };
const ON_CHAIN = "0x" + "ab".repeat(32);
recordEventFeedSigner(EVENT, "0x" + "fe".repeat(20), "0x" + "4b".repeat(20));

const storeDeps = { stamper: writer.getAttendeeStamper, upload: async (e: unknown, b: Uint8Array) => (await acceptingUploadChunk(e, b)).reference.toHex() };
const storing = { store: (d: string | Uint8Array, m: Parameters<typeof writer.storeAttendeePayload>[1]) => writer.storeAttendeePayload(d, m, storeDeps as never), now: () => Date.now() };
const failing = { store: async () => { throw new Error("bee down"); }, now: () => Date.now() };
let burns = 0;
const honestBurns = {
  stamper: writer.getAttendeeStamper,
  upload: async (burner: { identifier: Uint8Array; owner: Uint8Array }) => {
    burns++;
    return keccak256(concat([burner.identifier, burner.owner])).slice(2);
  },
};

let clock = Date.now();
let eraseBox: (root: string) => ReturnType<typeof eraseOrder> = (root) => eraseOrder(root, { by: "request" }, honestBurns as never);
const app = new Hono();
app.route("/api/holdings", holdingsRoutes({ eraseBox: (root) => eraseBox(root), now: () => clock }));
app.route("/api/ops", ops);

let sessions = 0;
const nextSession = () => `cs_test_hroutes${String(++sessions).padStart(8, "0")}`;
let seeds = 0;

function receiptsFor(pv: ReturnType<typeof holdingPublicValues>) {
  return pv.holders.map((holder, i) => {
    const burner = Wallet.createRandom();
    const holding = { eventId: ON_CHAIN, slot: 20 + i, holder, answerKey: pv.answerKeys[i]!, nkCommit: pv.nkCommit };
    return { holding, sig: signTicketHolding(TARGET, holding, Buffer.from(burner.privateKey.slice(2), "hex")) };
  });
}

/** A paid guest sale; `stored` = its box reached the attendee batch. */
async function guestSale(opts: { stored: boolean; emailHash?: string }) {
  const r = new Uint8Array(32).fill(++seeds);
  const pv = holdingPublicValues(r, 2);
  const sessionId = nextSession();
  const kept = await keepHoldingReceipts({
    sessionId, eventId: EVENT, seriesId: SERIES, target: TARGET, receipts: receiptsFor(pv),
    pickupId: pv.pickupId, pickupPub: Buffer.from(pv.pickupPub).toString("hex"),
    ...(opts.emailHash ? { emailHash: opts.emailHash } : {}),
    guest: { r, holders: pv.holders, answerKeys: pv.answerKeys, nkCommit: pv.nkCommit, pickupSigner: pv.pickupSigner },
  }, opts.stored ? storing : failing);
  return { r, pv, sessionId, boxRoot: kept!.boxRoot };
}

/** A signed-in buyer's sale, paid and kept (box stored or not). */
async function accountSale(account: string, opts: { paid?: boolean; stored?: boolean } = {}) {
  const r = new Uint8Array(32).fill(++seeds);
  const pv = holdingPublicValues(r, 1);
  const accountKey = holdingPickupKem(new Uint8Array(32).fill(250)).publicKey;
  const sealedR = await sealBox(accountKey, r, holdingSecretSealContext(pv.pickupId));
  const request = parseHoldingRequest({
    v: 1, holders: pv.holders, answerKeys: pv.answerKeys, nkCommit: pv.nkCommit, pickupId: pv.pickupId,
    pickupSigner: pv.pickupSigner, pickupPub: Buffer.from(pv.pickupPub).toString("hex"), sealedR,
  }, 1)!;
  const sessionId = nextSession();
  assert.ok(store.recordHoldingRequest({ sessionId, eventId: EVENT, seriesId: SERIES, account, request }));
  let boxRoot: string | undefined;
  if (opts.paid !== false) {
    boxRoot = (await keepHoldingReceipts({ sessionId, eventId: EVENT, seriesId: SERIES, target: TARGET, receipts: receiptsFor(pv), pickupId: pv.pickupId, pickupPub: request.pickupPub }, opts.stored ? storing : failing))!.boxRoot;
  }
  return { r, pv, sessionId, boxRoot, sealedR };
}

// Each request from its own address, so the per-IP limits stay out of the way (pinned on their own below).
let ips = 0;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": `10.0.${Math.floor(++ips / 250)}.${ips % 250}`, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function eraseBody(r: Uint8Array, pickupId: string, issuedAtSecs = Math.floor(clock / 1000), signerR = r) {
  return { pickupId, issuedAt: issuedAtSecs, sig: signErasePickup(pickupId, issuedAtSecs, holdingPickupSigner(signerR).privateKey) };
}

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf-8").digest("hex");

async function signedPost(path: string, wallet: Wallet, body = "{}") {
  const session = Wallet.createRandom();
  const nonce = randomUUID();
  const message = {
    host: HOST, parent: wallet.address, session: session.address, purpose: SESSION_PURPOSE, nonce,
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + SESSION_EXPIRY_MS).toISOString(),
    sessionProof: await session.signMessage(`${HOST}:${nonce}`), clientCodeHash: "0x" + "00".repeat(32),
    statement: `Authorize ${session.address} as session key for ${HOST}`,
  };
  const parentSig = await wallet.signTypedData(SESSION_DOMAIN, SESSION_TYPES as unknown as Parameters<typeof TypedDataEncoder.hash>[1], message);
  const timestamp = String(Date.now());
  const reqNonce = randomUUID();
  const challenge = ["woco-session-v1", "POST", path, timestamp, reqNonce, sha256Hex(body)].join("\n");
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Session-Address": session.address,
      "X-Session-Delegation": Buffer.from(JSON.stringify({ message, parentSig }), "utf-8").toString("base64"),
      "X-Session-Sig": await session.signMessage(challenge),
      "X-Session-Nonce": reqNonce,
      "X-Session-Timestamp": timestamp,
    },
    body,
  });
}

const setFlag = (on: boolean) => ((FEATURES as Record<string, boolean>).holdingReceiptsAllowed = on);
setFlag(true);

// ── The flag ────────────────────────────────────────────────────────────────

test("off: every route refuses before reading anything", async () => {
  const sale = await guestSale({ stored: false });
  setFlag(false);
  try {
    for (const res of [
      await post("/api/holdings/pickup", { pickupId: sale.pv.pickupId }),
      await post("/api/holdings/pickup/erase", await eraseBody(sale.r, sale.pv.pickupId)),
      await post("/api/holdings/mine", {}),
    ]) {
      assert.equal(res.status, 403);
      assert.match(((await res.json()) as { error: string }).error, /not available yet/);
    }
    assert.ok(store.getHolding(sale.sessionId)!.issued!.box, "nothing erased");
    assert.equal(store.getHolding(sale.sessionId)!.erasedAt, undefined);
  } finally {
    setFlag(true);
  }
});

// ── POST /pickup ────────────────────────────────────────────────────────────

test("pickup: the box while it waits here, only its root once on Swarm", async () => {
  const waiting = await guestSale({ stored: false });
  let res = await post("/api/holdings/pickup", { pickupId: waiting.pv.pickupId });
  assert.equal(res.status, 200);
  const a = (await res.json()) as { data: { boxRoot: string; box?: unknown } };
  assert.equal(a.data.boxRoot, waiting.boxRoot);
  assert.deepEqual(a.data.box, store.getHolding(waiting.sessionId)!.issued!.box);

  const onSwarm = await guestSale({ stored: true });
  res = await post("/api/holdings/pickup", { pickupId: onSwarm.pv.pickupId });
  assert.deepEqual(((await res.json()) as { data: unknown }).data, { boxRoot: onSwarm.boxRoot });
});

test("pickup: the id is read from the body only, never a path or a query string", async () => {
  const sale = await guestSale({ stored: false });
  assert.equal((await app.request(`/api/holdings/pickup/${sale.pv.pickupId}`, { method: "POST" })).status, 404);
  assert.equal((await app.request(`/api/holdings/pickup/${sale.pv.pickupId}`)).status, 404);
  assert.equal((await post(`/api/holdings/pickup?pickupId=${sale.pv.pickupId}`, {})).status, 400);
  for (const bad of [{}, { pickupId: sale.pv.pickupId.toUpperCase() }, { pickupId: "0x" + sale.pv.pickupId }, { pickupId: 1 }, [sale.pv.pickupId], "not json"]) {
    assert.equal((await post("/api/holdings/pickup", bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await post("/api/holdings/pickup", { pickupId: sale.pv.pickupId })).status, 200);
});

test("pickup: unknown, unpaid and erased read the same - not found", async () => {
  const unpaid = await accountSale("0x" + "a2".repeat(20), { paid: false });
  const erased = await guestSale({ stored: false });
  store.markHoldingErased(erased.sessionId);
  for (const pickupId of ["0f".repeat(32), unpaid.pv.pickupId, erased.pv.pickupId]) {
    const res = await post("/api/holdings/pickup", { pickupId });
    assert.equal(res.status, 404, pickupId);
  }
});

test("pickup: while a record is unreadable, 'not found' becomes 'try later'", async () => {
  const s = nextSession();
  const file = join(process.cwd(), ".data", "holding-receipts", `${s}.json`);
  writeFileSync(file, "{ broken", { mode: 0o600 });
  store._resetHoldingStoreForTests();
  try {
    assert.equal((await post("/api/holdings/pickup", { pickupId: "0e".repeat(32) })).status, 503);
    assert.equal((await post("/api/holdings/pickup/erase", { pickupId: "0e".repeat(32), issuedAt: 1, sig: "0x00" })).status, 503);
  } finally {
    store.deleteHolding(s);
  }
  assert.equal((await post("/api/holdings/pickup", { pickupId: "0e".repeat(32) })).status, 404);
});

// ── POST /pickup/erase ──────────────────────────────────────────────────────

test("erase, box not yet stored: tombstoned as a receipt so it can never be stored, public values kept", async () => {
  const sale = await guestSale({ stored: false, emailHash: "e5".repeat(32) });
  const before = store.getHolding(sale.sessionId)!;
  const res = await post("/api/holdings/pickup/erase", await eraseBody(sale.r, sale.pv.pickupId));
  assert.equal(res.status, 200);
  assert.deepEqual(((await res.json()) as { data: unknown }).data, { erased: true });

  const tomb = ledger.getOrderRecord(sale.boxRoot)!;
  assert.equal(tomb.state, "burned");
  assert.equal(tomb.kind, "holding", "never read as an organiser's order");
  assert.equal(tomb.erasedBy, "request");
  assert.equal(tomb.retainMonths, 12);
  assert.equal(tomb.emailHash, "e5".repeat(32), "a later request by email is answered 'erased'");

  const after = store.getHolding(sale.sessionId)!;
  assert.ok(after.erasedAt);
  assert.equal(after.issued!.box, undefined);
  assert.equal(after.issued!.emailHash, undefined);
  assert.deepEqual([after.holders, after.answerKeys, after.nkCommit, after.pickupPub], [before.holders, before.answerKeys, before.nkCommit, before.pickupPub]);

  const seen: string[] = [];
  await retryUnstoredHoldings(100, { store: (d, m) => (seen.push(String(d)), storing.store(d, m)), now: () => Date.now() });
  assert.equal(seen.includes(JSON.stringify(before.issued!.box)), false, "never sent to the batch");
  assert.equal((await post("/api/holdings/pickup", { pickupId: sale.pv.pickupId })).status, 404);
  // Again: nothing more to do, same answer.
  assert.equal((await post("/api/holdings/pickup/erase", await eraseBody(sale.r, sale.pv.pickupId))).status, 200);
});

test("erase, box on Swarm: every chunk burned, kind kept, no organiser door touched", async () => {
  const sale = await guestSale({ stored: true });
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(" "));
  const before = burns;
  try {
    assert.equal((await post("/api/holdings/pickup/erase", await eraseBody(sale.r, sale.pv.pickupId))).status, 200);
  } finally {
    console.warn = warn;
  }
  const rec = ledger.getOrderRecord(sale.boxRoot)!;
  assert.equal(rec.state, "burned");
  assert.equal(rec.kind, "holding");
  assert.equal(burns - before, rec.chunks.length);
  assert.equal(warnings.some((w) => /sale record|door/.test(w)), false, "the door path is the organiser order's, never run for a receipt");
  assert.ok(store.getHolding(sale.sessionId)!.erasedAt);
});

test("erase: a stale, early, foreign or broken signature is refused, and nothing changes", async () => {
  const sale = await guestSale({ stored: false });
  const now = Math.floor(clock / 1000);
  const other = new Uint8Array(32).fill(222);
  for (const [what, body] of [
    ["6 minutes old", await eraseBody(sale.r, sale.pv.pickupId, now - 6 * 60)],
    ["6 minutes ahead", await eraseBody(sale.r, sale.pv.pickupId, now + 6 * 60)],
    ["another order's signer", await eraseBody(sale.r, sale.pv.pickupId, now, other)],
    ["signed for another time", { ...(await eraseBody(sale.r, sale.pv.pickupId, now)), issuedAt: now - 1 }],
    ["not a signature", { pickupId: sale.pv.pickupId, issuedAt: now, sig: "0x1234" }],
  ] as const) {
    const res = await post("/api/holdings/pickup/erase", body);
    assert.equal(res.status, 403, what);
  }
  for (const bad of [
    { pickupId: sale.pv.pickupId, issuedAt: String(now), sig: "0x00" },
    { pickupId: sale.pv.pickupId, issuedAt: 1.5, sig: "0x00" },
    { pickupId: sale.pv.pickupId, issuedAt: now, sig: "0x" + "00".repeat(80) },
    { issuedAt: now, sig: "0x00" },
  ]) {
    assert.equal((await post("/api/holdings/pickup/erase", bad)).status, 400, JSON.stringify(bad));
  }
  // Inside the window, either side, it goes through.
  assert.equal((await post("/api/holdings/pickup/erase", await eraseBody(sale.r, sale.pv.pickupId, now - 4 * 60))).status, 200);
  assert.ok(store.getHolding(sale.sessionId)!.erasedAt);
  assert.ok(ledger.getOrderRecord(sale.boxRoot));
});

test("erase before payment: nothing to erase yet; unknown id: not found", async () => {
  const unpaid = await accountSale("0x" + "a3".repeat(20), { paid: false });
  assert.equal((await post("/api/holdings/pickup/erase", await eraseBody(unpaid.r, unpaid.pv.pickupId))).status, 409);
  assert.ok(store.getHolding(unpaid.sessionId)!.sealedR, "the request is untouched");
  const ghost = new Uint8Array(32).fill(223);
  assert.equal((await post("/api/holdings/pickup/erase", await eraseBody(ghost, "0d".repeat(32)))).status, 404);
});

test("erase while the box is being stored: try again in a minute, nothing changes; a failed burn: try later", async () => {
  const sale = await guestSale({ stored: false });
  store.setHoldingBoxStoring(sale.boxRoot, true);
  try {
    const res = await post("/api/holdings/pickup/erase", await eraseBody(sale.r, sale.pv.pickupId));
    assert.equal(res.status, 409);
    assert.equal(res.headers.get("Retry-After"), "60");
  } finally {
    store.setHoldingBoxStoring(sale.boxRoot, false);
  }
  assert.ok(store.getHolding(sale.sessionId)!.issued!.box);
  assert.equal(ledger.getOrderRecord(sale.boxRoot), null);

  const stored = await guestSale({ stored: true });
  eraseBox = async () => {
    throw new Error("bee unreachable");
  };
  try {
    assert.equal((await post("/api/holdings/pickup/erase", await eraseBody(stored.r, stored.pv.pickupId))).status, 503);
  } finally {
    eraseBox = (root) => eraseOrder(root, { by: "request" }, honestBurns as never);
  }
  assert.equal(store.getHolding(stored.sessionId)!.erasedAt, undefined, "nothing marked erased that was not");
});

test("an erasure meeting a real store in flight waits for it, then burns it", async () => {
  const r = new Uint8Array(32).fill(++seeds);
  const pv = holdingPublicValues(r, 1);
  const sessionId = nextSession();
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  const slow = { store: async (d: string | Uint8Array, m: Parameters<typeof storing.store>[1]) => (await gate, storing.store(d, m)), now: () => Date.now(), storeWaitMs: 10 };
  const kept = await keepHoldingReceipts({
    sessionId, eventId: EVENT, seriesId: SERIES, target: TARGET, receipts: receiptsFor(pv),
    pickupId: pv.pickupId, pickupPub: Buffer.from(pv.pickupPub).toString("hex"),
    guest: { r, holders: pv.holders, answerKeys: pv.answerKeys, nkCommit: pv.nkCommit, pickupSigner: pv.pickupSigner },
  }, slow as never);
  assert.deepEqual(await eraseOrder(kept!.boxRoot, { by: "request" }, honestBurns as never), { kind: "in-flight" });
  assert.equal(ledger.getOrderRecord(kept!.boxRoot), null, "no tombstone under a landing store");
  release();
  for (let i = 0; i < 200 && !store.getHolding(sessionId)!.issued!.storedAt; i++) await new Promise((res) => setTimeout(res, 10));
  assert.equal((await post("/api/holdings/pickup/erase", await eraseBody(r, pv.pickupId))).status, 200);
  assert.equal(ledger.getOrderRecord(kept!.boxRoot)!.state, "burned");
});

test("the shared erase drops a not-yet-stored box's local copy itself", async () => {
  const sale = await guestSale({ stored: false });
  assert.deepEqual(await eraseOrder(sale.boxRoot, { by: "request" }), { kind: "deleted-before-store" });
  assert.equal(store.getHolding(sale.sessionId)!.issued!.box, undefined);
  assert.equal((await post("/api/holdings/pickup", { pickupId: sale.pv.pickupId })).status, 200, "the record is the caller's to finish");
});

test("pickup and erase are limited per address", async () => {
  const ip = { "cf-connecting-ip": "192.0.2.7" };
  const pickups: number[] = [];
  for (let i = 0; i < 31; i++) pickups.push((await post("/api/holdings/pickup", { pickupId: "0c".repeat(32) }, ip)).status);
  assert.deepEqual([pickups[29], pickups[30]], [404, 429]);
  const erases: number[] = [];
  for (let i = 0; i < 11; i++) erases.push((await post("/api/holdings/pickup/erase", { pickupId: "0c".repeat(32), issuedAt: 1, sig: "0x00" }, ip)).status);
  assert.deepEqual([erases[9], erases[10]], [404, 429]);
  assert.equal((await post("/api/holdings/pickup", { pickupId: "0c".repeat(32) }, { "cf-connecting-ip": "192.0.2.8" })).status, 404, "another address is not held back");
});

// ── POST /mine ──────────────────────────────────────────────────────────────

test("mine: only the verified account's own paid, unerased sales - never one a body names", async () => {
  const me = Wallet.createRandom();
  const someone = Wallet.createRandom();
  const mine = await accountSale(me.address.toLowerCase(), { stored: false });
  const mineStored = await accountSale(me.address.toLowerCase(), { stored: true });
  const mineErased = await accountSale(me.address.toLowerCase(), { stored: false });
  store.markHoldingErased(mineErased.sessionId);
  await accountSale(me.address.toLowerCase(), { paid: false });
  const theirs = await accountSale(someone.address.toLowerCase(), { stored: false });
  await guestSale({ stored: false });

  const res = await signedPost("/api/holdings/mine", me, JSON.stringify({ account: someone.address }));
  assert.equal(res.status, 200);
  const data = ((await res.json()) as { data: { holdings: Array<Record<string, unknown>>; complete: boolean } }).data;
  assert.equal(data.complete, true);
  assert.deepEqual(data.holdings.map((h) => h.pickupId).sort(), [mine.pv.pickupId, mineStored.pv.pickupId].sort());
  const row = data.holdings.find((h) => h.pickupId === mine.pv.pickupId)!;
  assert.deepEqual(row, { eventId: EVENT, seriesId: SERIES, pickupId: mine.pv.pickupId, sealedR: mine.sealedR, boxRoot: mine.boxRoot, box: store.getHolding(mine.sessionId)!.issued!.box });
  assert.equal("box" in data.holdings.find((h) => h.pickupId === mineStored.pv.pickupId)!, false, "on Swarm: its root only");
  assert.equal(data.holdings.some((h) => h.pickupId === theirs.pv.pickupId), false);
});

test("mine: no session, no answer", async () => {
  assert.equal((await post("/api/holdings/mine", {})).status, 401);
});

// ── The erasure-request path (ops) and the other readers ────────────────────

const opsPost = (path: string, body: unknown) => post(path, body, { authorization: `Bearer ${"t".repeat(40)}` });

test("ops lookup by email finds a receipt box not yet stored; the burn tombstones it and deletes the record whole", async () => {
  const hash = "e7".repeat(32);
  const waiting = await guestSale({ stored: false, emailHash: hash });
  const onSwarm = await guestSale({ stored: true, emailHash: hash });
  type Lookup = { data: { orders: Array<{ root: string; kind: string }>; receipts: Array<{ root: string; kind: string }> } };
  let res = await opsPost("/api/ops/attendee-batch/lookup", { emailHash: hash });
  let data = ((await res.json()) as Lookup).data;
  assert.deepEqual(data.receipts.map((r) => r.root), [waiting.boxRoot], "not yet on the ledger: only here");
  assert.deepEqual(data.orders.map((o) => [o.root, o.kind]), [[onSwarm.boxRoot, "holding"]]);

  res = await opsPost(`/api/ops/attendee-batch/orders/${waiting.boxRoot}/burn`, { by: "test", reason: "erasure request" });
  assert.equal(res.status, 200);
  assert.deepEqual(((await res.json()) as { data: unknown }).data, { root: waiting.boxRoot, state: "deleted-before-store", burnedAt: null, receiptRecordDeleted: true });
  assert.equal(store.getHolding(waiting.sessionId), null, "a data-subject request deletes the record, public values too");
  assert.equal(ledger.getOrderRecord(waiting.boxRoot)?.kind, "holding");
  assert.equal(ledger.isOrderErased(waiting.boxRoot), true);

  res = await opsPost("/api/ops/attendee-batch/lookup", { emailHash: hash });
  data = ((await res.json()) as Lookup).data;
  assert.deepEqual(data.receipts, []);
  assert.ok(data.orders.some((o) => o.root === waiting.boxRoot), "answered 'erased' from the tombstone");

  // A stored one, erased through the same function the route uses; then the sweep deletes its record.
  assert.equal((await eraseOrder(onSwarm.boxRoot, { by: "request" }, honestBurns as never)).kind, "burned");
  store.sweepHoldings(ledger.isOrderErased);
  assert.equal(store.getHolding(onSwarm.sessionId), null);
});

test("ops lookup refuses while a receipt record is unreadable", async () => {
  const s = nextSession();
  writeFileSync(join(process.cwd(), ".data", "holding-receipts", `${s}.json`), "{ broken", { mode: 0o600 });
  store._resetHoldingStoreForTests();
  try {
    assert.equal((await opsPost("/api/ops/attendee-batch/lookup", { emailHash: "e8".repeat(32) })).status, 503);
  } finally {
    store.deleteHolding(s);
  }
});

test("the organiser's orders view never lists a receipt box, erased or asked about", async () => {
  const sale = await guestSale({ stored: true });
  await eraseOrder(sale.boxRoot, { by: "request" }, honestBurns as never);
  assert.equal(ledger.isOrderErased(sale.boxRoot), true);
  const status = ordersStatus({ eventId: EVENT, title: "t", series: [] }, [sale.boxRoot]);
  assert.equal(status.erased.includes(sale.boxRoot), false);
});
