/**
 * The automatic collection of signed-in receipts (`src/lib/holding/collect.ts`,
 * spec-receipt-note 5.1, slice 3c PR 2):
 * - every listed sale's secret is opened with whichever generation's key it was sealed to,
 *   and kept only when it gives the pickup id it is filed under;
 * - a box is kept only when it checks against the secret and names a known ledger;
 * - receipts are saved under the CONFIRMED-current generation, and our copy is erased
 *   ONLY after the save read back - never when the keys moved on or the save is unsure;
 * - a sale no key here opens is erased only when its copy is already in the account
 *   (carried by an upgrade to a passkey);
 * - the upgrade's read (`pendingCopies`) opens and checks, and never saves or erases.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { holdingSecretSealContext, sealBox } from "@woco/shared/crypto/sealed-box";
import type { SealedBoxV2 } from "@woco/shared/crypto/sealed-box-shape";
import type { HoldingBoxV1 } from "@woco/shared/holding/box";
import { holdingCopyOf, sameHoldingCopy } from "@woco/shared/holding/copy";
import { holdingPickupId } from "@woco/shared/holding/derive";
import { checkedHoldingBox } from "@woco/shared/holding/open";
import { mineHoldings, type EraseResult, type MineHolding, type MineResult } from "../src/lib/api/holdings.ts";
import { holdingGenKeysOf, readAllHoldingCopies, saveHoldingCopy, type HoldingGenKeys } from "../src/lib/holding/account-copy.ts";
import type { BoxSourceResult } from "../src/lib/holding/box-source.ts";
import { collectReceipts, openSaleSecret, pendingCopies, type CollectDeps } from "../src/lib/holding/collect.ts";
import { markKey, receiptMarks } from "../src/lib/holding/marks.ts";
import { ifLockFree } from "../src/lib/utils/web-lock.ts";
import { fakeFeeds, makeBox, sealFor, secret } from "./holding-fixture.ts";

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  throw new Error("no network in these tests");
}) as typeof fetch;
test.after(() => {
  globalThis.fetch = realFetch;
});

const S0 = `0x${"41".repeat(32)}`;
const S1 = `0x${"42".repeat(32)}`;
const STRANGER = `0x${"43".repeat(32)}`;
const R1 = secret(11);
const R2 = secret(12);
const R3 = secret(13);
const rootOf = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

async function sealedTo(keys: HoldingGenKeys, r: Uint8Array, pickupId = holdingPickupId(r)): Promise<SealedBoxV2> {
  return (await sealBox(keys.orderPublicKey, r, holdingSecretSealContext(pickupId))) as SealedBoxV2;
}

async function row(keys: HoldingGenKeys, r: Uint8Array, n: number, opts: { inline?: boolean; box?: HoldingBoxV1 } = {}): Promise<MineHolding> {
  const pickupId = holdingPickupId(r);
  return {
    pickupId,
    sealedR: await sealedTo(keys, r),
    boxRoot: rootOf(n),
    ...(opts.inline ? { box: (await sealFor(r, opts.box ?? makeBox(r, 1, n * 10))) as SealedBoxV2 } : {}),
  };
}

/** A box that checks against `r` but names a ticket ledger this build does not know. */
function foreignBox(r: Uint8Array): HoldingBoxV1 {
  const box = makeBox(r, 1);
  return { v: 1, receipts: box.receipts.map((e) => ({ ...e, ledger: "0x" + "99".repeat(20) })) };
}

function harness(opts: {
  rows: MineHolding[];
  complete?: boolean;
  gens: HoldingGenKeys[];
  current?: HoldingGenKeys | null;
  /** root -> the box Swarm serves there. */
  swarm?: Map<string, { r: Uint8Array; box: HoldingBoxV1 }>;
  erase?: (pickupId: string) => EraseResult;
  stillCurrent?: () => boolean;
  feeds?: ReturnType<typeof fakeFeeds>;
  mine?: MineResult;
}) {
  const feeds = opts.feeds ?? fakeFeeds();
  const log: string[] = [];
  feeds.beforeWrite = () => void log.push("write");
  const erased: string[] = [];
  const fetched: string[] = [];
  let stillAsked = 0;
  const deps: CollectDeps = {
    mine: async () => (log.push("mine"), opts.mine ?? { kind: "ok", holdings: opts.rows, complete: opts.complete ?? true }),
    gens: opts.gens,
    current: opts.current === undefined ? opts.gens.at(-1)! : opts.current,
    fetchBox: async (r, root): Promise<BoxSourceResult> => {
      fetched.push(root);
      const got = opts.swarm?.get(root);
      if (!got) return { kind: "later" };
      return { kind: "ok", ...checkedHoldingBox(r, got.box), boxRoot: root };
    },
    io: feeds.io,
    keep: {
      io: feeds.io,
      erase: async (pickupId) => {
        log.push(`erase:${pickupId}`);
        const out = opts.erase ? opts.erase(pickupId) : "erased";
        if (out === "erased") erased.push(pickupId);
        return out;
      },
      now: () => Date.now(),
    },
    stillCurrent: async () => (stillAsked++, opts.stillCurrent ? opts.stillCurrent() : true),
  };
  return { deps, feeds, log, erased, fetched, stillAsked: () => stillAsked };
}

test("every listed sale: opened with the generation it was sealed to, saved under the CURRENT one, read back, then our copy erased", async () => {
  const g0 = await holdingGenKeysOf(S0);
  const g1 = await holdingGenKeysOf(S1);
  // R1 was bought before a passkey removal (sealed to g0), R2 after (g1).
  const rows = [await row(g0, R1, 1), await row(g1, R2, 2)];
  const swarm = new Map([[rootOf(1), { r: R1, box: makeBox(R1, 2, 10) }], [rootOf(2), { r: R2, box: makeBox(R2, 1, 20) }]]);
  const h = harness({ rows, gens: [g0, g1], swarm });
  const report = await collectReceipts(h.deps);
  assert.deepEqual(report, { saved: 2, erased: 2, left: 0, skipped: 0, done: true });

  const under1 = await readAllHoldingCopies([g1], h.feeds.io);
  assert.equal(under1.complete, true);
  assert.deepEqual(under1.copies.map((c) => c.entry.pickupId).sort(), [R1, R2].map((r) => holdingPickupId(r)).sort());
  assert.ok(sameHoldingCopy(under1.copies.find((c) => c.entry.pickupId === holdingPickupId(R1))!.copy, holdingCopyOf(R1, makeBox(R1, 2, 10))));
  assert.equal((await readAllHoldingCopies([g0], h.feeds.io)).copies.length, 0, "nothing saved under the old generation");
  assert.deepEqual(h.erased, [R1, R2].map((r) => holdingPickupId(r)));
  // Each order's copy and list line are written before its erase, all under the current signer.
  const [p1, p2] = [R1, R2].map((r) => holdingPickupId(r));
  assert.deepEqual(h.log, ["mine", "write", "write", `erase:${p1}`, "write", "write", `erase:${p2}`]);
  assert.ok(h.feeds.writes.every((w) => w.owner.toLowerCase() === g1.signer.address.toLowerCase()));
  assert.equal(h.stillAsked(), 2, "the check before each save");
});

test("an account that stops being current mid-run (an upgrade begun, a sign-out): no later save or erase", async () => {
  const g = await holdingGenKeysOf(S0);
  const rows = [await row(g, R1, 1, { inline: true }), await row(g, R2, 2, { inline: true }), await row(g, R3, 3, { inline: true })];
  let asked = 0;
  const h = harness({ rows, gens: [g], stillCurrent: () => ++asked === 1 });
  assert.deepEqual(await collectReceipts(h.deps), { saved: 1, erased: 1, left: 2, skipped: 0, done: false });
  assert.deepEqual(h.erased, [holdingPickupId(R1)]);
  assert.equal(h.log.filter((x) => x === "write").length, 2, "only the first order's copy and line");
});

test("the box from the answer while the server still waits to store it; otherwise from Swarm by its root", async () => {
  const g = await holdingGenKeysOf(S0);
  const rows = [await row(g, R1, 1, { inline: true }), await row(g, R2, 2)];
  const h = harness({ rows, gens: [g], swarm: new Map([[rootOf(2), { r: R2, box: makeBox(R2, 1, 20) }]]) });
  const report = await collectReceipts(h.deps);
  assert.equal(report.saved, 2);
  assert.deepEqual(h.fetched, [rootOf(2)], "no fetch for the box the answer carried");

  // An inline box that is not this order's falls back to Swarm, and is kept only from there.
  const bad = await row(g, R3, 3);
  bad.box = (await sealFor(R3, makeBox(R1, 1))) as SealedBoxV2;
  const h2 = harness({ rows: [bad], gens: [g] });
  const r2 = await collectReceipts(h2.deps);
  assert.deepEqual(h2.fetched, [rootOf(3)]);
  assert.deepEqual(r2, { saved: 0, erased: 0, left: 1, skipped: 0, done: false });
});

test("our copy is never erased unless the account's copy read back", async () => {
  const g = await holdingGenKeysOf(S0);
  const h = harness({ rows: [await row(g, R1, 1, { inline: true })], gens: [g] });
  h.feeds.unconfirmAfter = 0;
  const report = await collectReceipts(h.deps);
  assert.deepEqual(report, { saved: 0, erased: 0, left: 1, skipped: 0, done: false });
  assert.deepEqual(h.erased, []);
  assert.ok(!h.log.some((x) => x.startsWith("erase:")));
});

test("keys that moved on, or a generation not confirmed: nothing saved, nothing erased", async () => {
  const g = await holdingGenKeysOf(S0);
  const rows = [await row(g, R1, 1, { inline: true }), await row(g, R2, 2, { inline: true })];
  const moved = harness({ rows, gens: [g], stillCurrent: () => false });
  assert.deepEqual(await collectReceipts(moved.deps), { saved: 0, erased: 0, left: 2, skipped: 0, done: false });
  assert.equal(moved.feeds.writes.length, 0);
  assert.ok(!moved.log.some((x) => x.startsWith("erase:")));
  assert.equal(moved.stillAsked(), 2, "asked before each");

  const unconfirmed = harness({ rows, gens: [g], current: null });
  assert.deepEqual(await collectReceipts(unconfirmed.deps), { saved: 0, erased: 0, left: 2, skipped: 0, done: false });
  assert.equal(unconfirmed.feeds.writes.length, 0);
});

test("a secret filed under another sale's id, or sealed to no key here, is never kept or erased", async () => {
  const g = await holdingGenKeysOf(S0);
  const stranger = await holdingGenKeysOf(STRANGER);
  // R2's secret sealed under R1's id: it opens, and gives another id.
  const misfiled: MineHolding = { pickupId: holdingPickupId(R1), sealedR: await sealedTo(g, R2, holdingPickupId(R1)), boxRoot: rootOf(1) };
  assert.equal(await openSaleSecret(misfiled, [g]), null);
  const foreign = await row(stranger, R3, 3, { inline: true });
  const h = harness({ rows: [misfiled, foreign], gens: [g] });
  assert.deepEqual(await collectReceipts(h.deps), { saved: 0, erased: 0, left: 0, skipped: 2, done: true });
  assert.equal(h.feeds.writes.length, 0);
  assert.ok(!h.log.some((x) => x.startsWith("erase:")));
});

test("a box refused, naming an unknown ledger, or gone since the list: skipped, nothing saved or erased", async () => {
  const g = await holdingGenKeysOf(S0);
  const rows = [await row(g, R1, 1, { inline: true, box: foreignBox(R1) }), await row(g, R2, 2)];
  const h = harness({ rows, gens: [g] });
  h.deps.fetchBox = async (_r, root) => (root === rootOf(1) ? { kind: "refused", reason: "not-this-order" } : { kind: "not-found" });
  assert.deepEqual(await collectReceipts(h.deps), { saved: 0, erased: 0, left: 0, skipped: 2, done: true });
  assert.equal(h.feeds.writes.length, 0);
});

test("a sale an upgrade already carried (no key here opens it): our copy erased with the secret its copy keeps", async () => {
  const oldSeed = await holdingGenKeysOf(STRANGER);
  const g = await holdingGenKeysOf(S0);
  const feeds = fakeFeeds();
  // The upgrade saved it under the passkey's seed without erasing (Undo must stay possible).
  await saveHoldingCopy(g, R1, makeBox(R1, 1), feeds.io);
  const writes = feeds.writes.length;
  const carried = await row(oldSeed, R1, 1, { inline: true });
  const h = harness({ rows: [carried], gens: [g], feeds });
  assert.deepEqual(await collectReceipts(h.deps), { saved: 1, erased: 1, left: 0, skipped: 0, done: true });
  assert.deepEqual(h.erased, [holdingPickupId(R1)]);
  assert.equal(feeds.writes.length, writes, "nothing written again");

  // Its erase answered "later": counted as saved, and left for the next run.
  const busy = harness({ rows: [carried], gens: [g], feeds, erase: () => "later" });
  assert.deepEqual(await collectReceipts(busy.deps), { saved: 1, erased: 0, left: 1, skipped: 0, done: false });

  // Not in the account: left alone - the erase would lose the only copy.
  const none = harness({ rows: [await row(oldSeed, R2, 2, { inline: true })], gens: [g] });
  assert.deepEqual(await collectReceipts(none.deps), { saved: 0, erased: 0, left: 0, skipped: 1, done: true });
  assert.ok(!none.log.some((x) => x.startsWith("erase:")));

  // Its copy unreadable now: tried again later, never erased blind.
  const unsure = harness({ rows: [carried], gens: [g], feeds });
  const { holdingCopyTopic } = await import("@woco/shared/holding/copy");
  feeds.failReads.add(holdingCopyTopic(g.salt, holdingPickupId(R1)));
  assert.deepEqual(await collectReceipts(unsure.deps), { saved: 0, erased: 0, left: 1, skipped: 0, done: false });
  assert.ok(!unsure.log.some((x) => x.startsWith("erase:")));

  // And never once the keys moved on.
  feeds.failReads.clear();
  const moved = harness({ rows: [carried], gens: [g], feeds, stillCurrent: () => false });
  assert.deepEqual(await collectReceipts(moved.deps), { saved: 0, erased: 0, left: 1, skipped: 0, done: false });
  assert.ok(!moved.log.some((x) => x.startsWith("erase:")));
});

test("an erase answered 'later' is finished by the next run, which writes nothing again", async () => {
  const g = await holdingGenKeysOf(S0);
  const rows = [await row(g, R1, 1, { inline: true })];
  let answer: EraseResult = "later";
  const feeds = fakeFeeds();
  const first = harness({ rows, gens: [g], feeds, erase: () => answer });
  assert.deepEqual(await collectReceipts(first.deps), { saved: 1, erased: 0, left: 1, skipped: 0, done: false });
  const writes = feeds.writes.length;
  answer = "erased";
  const second = harness({ rows, gens: [g], feeds, erase: () => answer });
  assert.deepEqual(await collectReceipts(second.deps), { saved: 1, erased: 1, left: 0, skipped: 0, done: true });
  assert.equal(feeds.writes.length, writes, "the copy and its line were already there");
  // "gone" (already erased) counts as erased too.
  answer = "gone";
  const third = harness({ rows, gens: [g], feeds, erase: () => answer });
  assert.equal((await collectReceipts(third.deps)).erased, 1);
});

test("an unanswered list, a box not fetched, or a short list: never 'done'", async () => {
  const g = await holdingGenKeysOf(S0);
  const later = harness({ rows: [], gens: [g], mine: { kind: "later" } });
  assert.deepEqual(await collectReceipts(later.deps), { saved: 0, erased: 0, left: 0, skipped: 0, done: false });
  assert.equal(later.stillAsked(), 0);

  const unfetched = harness({ rows: [await row(g, R1, 1)], gens: [g] });
  assert.deepEqual(await collectReceipts(unfetched.deps), { saved: 0, erased: 0, left: 1, skipped: 0, done: false });

  const short = harness({ rows: [await row(g, R1, 1, { inline: true })], gens: [g], complete: false });
  const r = await collectReceipts(short.deps);
  assert.equal(r.saved, 1);
  assert.equal(r.done, false, "the server could not read every record");

  const empty = harness({ rows: [], gens: [g] });
  assert.deepEqual(await collectReceipts(empty.deps), { saved: 0, erased: 0, left: 0, skipped: 0, done: true });
});

test("the upgrade's read opens and checks every sale the old seed opens, and saves or erases nothing", async () => {
  const old = await holdingGenKeysOf(S0);
  const other = await holdingGenKeysOf(S1);
  const rows = [
    await row(old, R1, 1, { inline: true }),
    await row(old, R2, 2),
    await row(other, R3, 3, { inline: true }),
    await row(old, secret(14), 4, { inline: true, box: foreignBox(secret(14)) }),
  ];
  const h = harness({ rows, gens: [old], swarm: new Map([[rootOf(2), { r: R2, box: makeBox(R2, 1, 20) }]]) });
  const got = await pendingCopies(h.deps);
  assert.ok(got !== "unavailable");
  assert.deepEqual(got.map((c) => c.entry.pickupId), [R1, R2].map((r) => holdingPickupId(r)), "not another seed's, not an unknown ledger");
  assert.ok(sameHoldingCopy(got[1]!.copy, holdingCopyOf(R2, makeBox(R2, 1, 20))));
  assert.equal(h.feeds.writes.length, 0);
  assert.ok(!h.log.some((x) => x.startsWith("erase:")));

  // Anything it could not read makes the whole read unavailable: carrying part would lose the rest.
  const swarm = new Map([[rootOf(2), { r: R2, box: makeBox(R2, 1, 20) }]]);
  for (const over of [{ mine: { kind: "later" } as MineResult }, { complete: false }]) {
    assert.equal(await pendingCopies(harness({ rows, gens: [old], swarm, ...over }).deps), "unavailable");
  }
  const unfetched = harness({ rows: [await row(old, R2, 2)], gens: [old] });
  assert.equal(await pendingCopies(unfetched.deps), "unavailable");
});

test("mine: signed, never a new sign-in; only well-formed rows; anything else is 'later'", async () => {
  const g = await holdingGenKeysOf(S0);
  const good = await row(g, R1, 1, { inline: true });
  const plain = await row(g, R2, 2);
  const sent: string[] = [];
  const reply = (body: unknown) => async (path: string) => (sent.push(path), body as { ok: boolean; data?: { holdings?: unknown; complete?: unknown } });
  assert.deepEqual(await mineHoldings(reply({ ok: true, data: { holdings: [good, plain], complete: true } })), {
    kind: "ok",
    holdings: [good, plain],
    complete: true,
  });
  assert.deepEqual(sent, ["/api/holdings/mine"]);
  const extra = { ...plain, eventId: "e", seriesId: "s" };
  assert.deepEqual((await mineHoldings(reply({ ok: true, data: { holdings: [extra], complete: true } }))), { kind: "ok", holdings: [plain], complete: true }, "only the fields it needs");

  for (const bad of [{ ...plain, pickupId: "zz" }, { ...plain, boxRoot: "x" }, { ...plain, sealedR: { v: 1 } }, { ...plain, box: { v: 2 } }, null]) {
    assert.deepEqual(await mineHoldings(reply({ ok: true, data: { holdings: [good, bad], complete: true } })), { kind: "ok", holdings: [good], complete: false });
  }
  for (const body of [{ ok: false }, { ok: true }, { ok: true, data: { holdings: "x", complete: true } }, { ok: true, data: { holdings: [] } }]) {
    assert.deepEqual(await mineHoldings(reply(body)), { kind: "later" });
  }
  assert.deepEqual(await mineHoldings(async () => { throw new Error("Not authenticated"); }), { kind: "later" });
});

test("the per-ticket mark: one per ticket number the lists name; a read that missed a list keeps what the last one showed", async () => {
  const { holdingIndexEntryOf } = await import("@woco/shared/holding/copy");
  const a = holdingIndexEntryOf(holdingPickupId(R1), makeBox(R1, 2, 10)); // tickets 11, 12
  const b = holdingIndexEntryOf(holdingPickupId(R2), makeBox(R2, 1, 20, "series-2")); // ticket 21
  const marks = receiptMarks([a, b], true, new Set(["evt-1|series-9#1"]));
  assert.deepEqual([...marks].sort(), ["evt-1|series-1#11", "evt-1|series-1#12", "evt-1|series-2#21"], "a whole read replaces the last");
  // The passport keys a ticket by its event, series and number.
  assert.ok(marks.has(markKey("evt-1", "series-1", 12)));
  assert.ok(!marks.has(markKey("evt-2", "series-1", 12)), "another event's ticket with the same series id and number");
  assert.ok(!marks.has(markKey("evt-1", "series-1", 13)));
  // One list unreadable this time: the marks it gave before stay.
  const partial = receiptMarks([b], false, marks);
  assert.deepEqual([...partial].sort(), [...marks].sort());
  assert.deepEqual([...receiptMarks([], false, undefined)], []);
});

test("the browser's Web Locks are used where it has them; this tab's chain only where it has not", async () => {
  const { withWebLock } = await import("../src/lib/utils/web-lock.ts");
  const asked: string[] = [];
  const locks = { request: <T,>(name: string, cb: () => Promise<T>) => (asked.push(name), cb()) };
  assert.equal(await withWebLock("test:save", async () => "done", { timeoutMs: 1_000, locks }), "done");
  assert.deepEqual(asked, ["test:save"]);
  asked.length = 0;
  assert.equal(await withWebLock("test:save", async () => "here", { timeoutMs: 1_000, locks: null }), "here");
  assert.deepEqual(asked, []);
});

test("one collection per account at a time: a second start while one runs does not run", async () => {
  for (const locks of [undefined, null] as const) {
    let release!: () => void;
    const first = ifLockFree("test:collect", () => new Promise<string>((r) => (release = () => r("first"))), { locks });
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(await ifLockFree("test:collect", async () => "second", { locks }), { ran: false });
    release();
    assert.deepEqual(await first, { ran: true, value: "first" });
    assert.deepEqual(await ifLockFree("test:collect", async () => "third", { locks }), { ran: true, value: "third" });
  }
});
