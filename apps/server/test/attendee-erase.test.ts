/**
 * `eraseOrder` (#546, #547): the one erase an erasure request and the retention
 * sweep share. The ops route must answer exactly as it did before the
 * extraction, and every erasure must say who started it and, for the sweep,
 * which instruction it carried out.
 *
 * MUTATION: drop the in-flight check and "a store in flight" goes red; drop the
 * hold release and "held only" goes red; drop `noteErasure` from `burnOrder` and
 * "a burn records why" goes red; let `noteErasure` overwrite and "first writer
 * wins" goes red; drop the tombstone's retainMonths or erasure and "held only"
 * goes red; drop `forgetAtTheDoor` from either branch and its "leaves the door" test
 * goes red.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { concat, keccak256 } from "ethers";

process.chdir(mkdtempSync(join(tmpdir(), "woco-attendee-erase-")));
process.env.BEE_URL = "http://127.0.0.1:1";
process.env.EMAIL_HASH_SECRET ??= "0".repeat(64);
process.env.FEED_PRIVATE_KEY ??= "11".repeat(32);
process.env.OPS_TOKEN = "t".repeat(40);
process.env.CHECKIN_PASS_SECRET ??= "test-door-pass-secret";
globalThis.fetch = (async () => {
  throw new Error("bee unreachable");
}) as unknown as typeof fetch;

const { ops } = await import("../src/routes/ops.js");
const ledger = await import("../src/lib/attendee-batch/ledger.js");
const held = await import("../src/lib/attendee-batch/held-orders.js");
const writer = await import("../src/lib/attendee-batch/writer.js");
const { eraseOrder } = await import("../src/lib/attendee-batch/erase.js");
const { readyAttendeeStore, acceptingUploadChunk } = await import("./helpers/attendee-store.js");
const { canonicalOrderBox } = await import("../src/lib/stripe/order-ref.js");
const { recordEventFeedSigner } = await import("../src/lib/event/feed-signer-record.js");

await readyAttendeeStore();
const ORGANISER = "0x" + "7e".repeat(20);
recordEventFeedSigner("e-erase", "0x" + "fd".repeat(20), ORGANISER);

const app = new Hono();
app.route("/api/ops", ops);
const burnRoute = (root: string) =>
  app.request(`/api/ops/attendee-batch/orders/${root}/burn`, {
    method: "POST",
    headers: { authorization: `Bearer ${"t".repeat(40)}`, "content-type": "application/json" },
    body: JSON.stringify({ by: "test", reason: "erasure request" }),
  });

const storeDeps = { stamper: writer.getAttendeeStamper, upload: async (_e: unknown, body: Uint8Array) => (await acceptingUploadChunk(_e, body)).reference.toHex() };
let uploads = 0;
const honestBurns = {
  stamper: writer.getAttendeeStamper,
  upload: async (burner: { identifier: Uint8Array; owner: Uint8Array }) => {
    uploads++;
    return keccak256(concat([burner.identifier, burner.owner])).slice(2);
  },
};
const RULE = { retainMonths: 6, endMs: Date.parse("2026-03-01T00:00:00Z"), endSource: "chain" as const, dueAt: "2026-09-01T00:00:00.000Z" };

let seq = 0;
async function stored(): Promise<string> {
  return writer.storeAttendeePayload(`order ${++seq} `.repeat(400), { kind: "checkout", eventId: "e-erase", seriesId: "s1", retainMonths: 6 }, storeDeps as never);
}
async function heldPaid(retainMonths?: number): Promise<string> {
  const json = canonicalOrderBox({ v: 2, enc: "ab".repeat(1120), ct: (++seq).toString(16).padStart(2, "0").repeat(64) })!;
  const ref = await writer.orderRefOf(json);
  held.commitHold(ref, json, { eventId: "e-erase", seriesId: "s1" });
  held.markHeldPaid(ref, `cs_${seq}`, Date.now(), { emailHash: "ee".repeat(32), ...(retainMonths ? { retainMonths } : {}) });
  return ref;
}

test("route: an unknown reference is 404, as before", async () => {
  const res = await burnRoute("ab".repeat(32));
  assert.equal(res.status, 404);
});

test("route: held only -> hold deleted, tombstone says a request erased it and keeps who and the period", async () => {
  const ref = await heldPaid(12);
  const res = await burnRoute(ref);
  assert.equal(res.status, 200);
  assert.deepEqual(((await res.json()) as { data: unknown }).data, { root: ref, state: "deleted-before-store", burnedAt: null });
  assert.equal(held.getHeldOrder(ref), null);
  const rec = ledger.getOrderRecord(ref)!;
  assert.equal(rec.state, "burned");
  assert.equal(rec.erasedBy, "request");
  assert.equal(rec.retentionRule, undefined);
  assert.equal(rec.retainMonths, 12);
  assert.equal(rec.organiser, ORGANISER);
  assert.equal(rec.emailHash, "ee".repeat(32));
});

test("route: a stored order whose burn cannot reach bee is 502, already hidden, and records the request", async () => {
  const ref = await stored();
  const res = await burnRoute(ref);
  assert.equal(res.status, 502);
  assert.match(((await res.json()) as { error: string }).error, /bee unreachable/);
  assert.equal(ledger.isOrderErased(ref), true, "readers are gated from the first planned burn");
  assert.equal(ledger.getOrderRecord(ref)?.erasedBy, "request");
});

test("a store in flight is refused and its hold left alone", async () => {
  const ref = await heldPaid(6);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow = { stamper: writer.getAttendeeStamper, upload: async (e: unknown, b: Uint8Array) => { await gate; return storeDeps.upload(e, b); } };
  const storing = writer.storeHeldOrder(ref, slow as never);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await eraseOrder(ref, { by: "retention", rule: RULE }), { kind: "in-flight" });
  assert.ok(held.getHeldOrder(ref));
  assert.equal((await burnRoute(ref)).status, 409, "the route's answer is unchanged");
  release();
  await storing;
});

test("a retention burn records why and the rule it carried out", async () => {
  const ref = await stored();
  const before = uploads;
  const out = await eraseOrder(ref, { by: "retention", rule: RULE }, honestBurns as never);
  assert.equal(out.kind, "burned");
  const rec = ledger.getOrderRecord(ref)!;
  assert.equal(rec.state, "burned");
  assert.equal(rec.erasedBy, "retention");
  assert.deepEqual(rec.retentionRule, RULE);
  assert.equal(uploads - before, rec.chunks.length, "one burner per chunk");
});

test("a retention erase of a held order writes the tombstone with the rule and the hold's period", async () => {
  const ref = await heldPaid(6);
  assert.deepEqual(await eraseOrder(ref, { by: "retention", rule: RULE }), { kind: "deleted-before-store" });
  const rec = ledger.getOrderRecord(ref)!;
  assert.equal(rec.erasedBy, "retention");
  assert.deepEqual(rec.retentionRule, RULE);
  assert.equal(rec.retainMonths, 6);
  assert.equal(rec.organiser, ORGANISER);
});

test("first writer wins: a request burn resumed by the sweep still says request", async () => {
  const ref = await stored();
  await assert.rejects(eraseOrder(ref, { by: "request" }), /bee unreachable/);
  await eraseOrder(ref, { by: "retention", rule: RULE }, honestBurns as never);
  const rec = ledger.getOrderRecord(ref)!;
  assert.equal(rec.state, "burned");
  assert.equal(rec.erasedBy, "request");
  assert.equal(rec.retentionRule, undefined);
});

test("an order already erased is a no-op: no upload, nothing rewritten", async () => {
  const ref = await stored();
  await eraseOrder(ref, { by: "request" }, honestBurns as never);
  const before = uploads;
  const out = await eraseOrder(ref, { by: "retention", rule: RULE }, honestBurns as never);
  assert.equal(out.kind, "burned");
  assert.equal(uploads, before);
  assert.equal(ledger.getOrderRecord(ref)?.erasedBy, "request");
});

test("an order burned before #547 is never relabelled", async () => {
  const ref = await stored();
  await eraseOrder(ref, { by: "request" }, honestBurns as never);
  const rec = ledger.getOrderRecord(ref)!;
  assert.equal(rec.state, "burned");
  // As a pre-#547 burn left it: no reason recorded.
  const file = join(process.cwd(), ".data", "attendee-slots.json");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  delete raw.orders[ref].erasedBy;
  writeFileSync(file, JSON.stringify(raw));
  ledger._resetAttendeeLedgerForTests();
  ledger.noteErasure(ref, { by: "retention", rule: RULE });
  assert.equal(ledger.getOrderRecord(ref)?.erasedBy, undefined);
});

test("the live fulfilment wiring hands the period to the hold", () => {
  const src = readFileSync(new URL("../src/lib/stripe/fulfilment-live.ts", import.meta.url), "utf8");
  assert.match(src, /claimHeldOrder: \(ref, sessionId, emailHash, retainMonths\) => markHeldPaid\(ref, sessionId, Date\.now\(\), \{ emailHash, retainMonths \}\)/);
  assert.match(src, /storeOrderBlob: \(data, meta\) => storeAttendeePayload\(data, \{ kind: "fallback", \.\.\.meta \}\)/);
});

// ---------------------------------------------------------------------------
// The door (live door attendee list): an erased order's tickets leave every scanner
// ---------------------------------------------------------------------------

const checkinStore = await import("../src/lib/checkin/store.js");
const doorEntries = await import("../src/lib/checkin/door-entries.js");
const sales = await import("../src/lib/stripe/ticket-sales.js");
const { doorEntriesKeypair } = await import("@woco/shared/checkin/door-entries-key");
const { doorKeyRefOf } = await import("@woco/shared/checkin/door-keys");

const DOOR_JTI = "d".repeat(32);
const doorKey = doorEntriesKeypair(new Uint8Array(32).fill(9)).publicKey;
doorEntries.startDoorEntries("e-erase", DOOR_JTI, Buffer.from(doorKey).toString("hex"));
checkinStore.issueDoorPass("e-erase", Math.floor(Date.now() / 1000) + 3600, undefined, "several", 0, { jti: DOOR_JTI, doorKeyRef: doorKeyRefOf(doorKey) });

async function soldAtTheDoor(ref: string, slots: number[]): Promise<void> {
  const sessionId = `cs_door_${ref.slice(0, 8)}`;
  sales.recordSaleStub({ sessionId, paymentIntentId: `pi_${ref.slice(0, 8)}`, connectedAccountId: "acct_1", eventId: "e-erase", seriesId: "s1", quantity: slots.length, amountTotal: 1000, currency: "gbp" });
  sales.recordSaleSlots(sessionId, "0x" + "0e".repeat(32), "c", slots, ref);
  await doorEntries.sealDoorEntries("e-erase", slots.map((s) => ({ seriesId: "s1", edition: s + 1 })), { email: "door@example.com" });
}

const doorLines = () => doorEntries.readDoorEntriesPage("e-erase", DOOR_JTI, 0).log;

test("a burned order leaves the door: its sealed lines go and a removal per ticket is logged", async () => {
  const ref = await stored();
  await soldAtTheDoor(ref, [10, 11]);
  assert.equal(doorLines().filter((l) => l.kind === "add" && l.edition >= 11).length, 2);
  await eraseOrder(ref, { by: "request" }, honestBurns as never);
  const lines = doorLines().filter((l) => l.edition === 11 || l.edition === 12);
  assert.deepEqual(lines.map((l) => [l.kind, l.edition]), [["remove", 11], ["remove", 12]]);
});

test("an order erased before it was stored leaves the door too", async () => {
  const ref = await heldPaid(6);
  await soldAtTheDoor(ref, [20]);
  assert.deepEqual(await eraseOrder(ref, { by: "request" }), { kind: "deleted-before-store" });
  assert.deepEqual(doorLines().filter((l) => l.edition === 21).map((l) => l.kind), ["remove"]);
});

test("an unknown order touches nothing at the door", async () => {
  const before = JSON.stringify(doorLines());
  assert.deepEqual(await eraseOrder("cd".repeat(32), { by: "request" }), { kind: "not-found" });
  assert.equal(JSON.stringify(doorLines()), before);
});

// ---------------------------------------------------------------------------
// #983: an erased order's held tickets go with it
// ---------------------------------------------------------------------------

const holds = await import("../src/lib/ticket-hold/store.js");
const { deriveXWingKeypairFromSeed } = await import("@woco/shared/crypto/xwing");
const HOLD_KEY = deriveXWingKeypairFromSeed("0x" + "4d".repeat(32)).publicKey;

async function soldAndHeld(ref: string, slot: number): Promise<string> {
  const sessionId = `cs_test_erase${ref.slice(0, 10)}`;
  sales.recordSaleStub({ sessionId, paymentIntentId: `pi_h${ref.slice(0, 8)}`, connectedAccountId: "acct_1", eventId: "e-erase", seriesId: "s1", quantity: 1, amountTotal: 1000, currency: "gbp" });
  sales.recordSaleSlots(sessionId, "0x" + "0e".repeat(32), "c", [slot], ref);
  const qrContent = `woco://t/e-erase/s1/${slot + 1}/0x${"cd".repeat(65)}`;
  assert.equal(await holds.holdTickets({ sessionId, eventId: "e-erase", seriesId: "s1", orderKeyRef: "ab".repeat(32), tickets: [{ edition: slot + 1, qrContent }] }, async () => HOLD_KEY), true);
  return sessionId;
}

test("#983: a burned order's held tickets are deleted", async () => {
  const ref = await stored();
  const sessionId = await soldAndHeld(ref, 40);
  await eraseOrder(ref, { by: "request" }, honestBurns as never);
  assert.equal(holds.getTicketHold(sessionId), null);
});

test("#983: an order erased before it was stored takes its held tickets too", async () => {
  const ref = await heldPaid(8);
  const sessionId = await soldAndHeld(ref, 41);
  assert.deepEqual(await eraseOrder(ref, { by: "request" }), { kind: "deleted-before-store" });
  assert.equal(holds.getTicketHold(sessionId), null);
});
