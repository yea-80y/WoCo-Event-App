/**
 * Keeping a receipt and erasing the server's copy (`src/lib/holding/keep.ts`), getting the
 * box (`box-source.ts`) and the two unauthenticated calls (`src/lib/api/holdings.ts`).
 * The rule under test: the server's copy is erased ONLY after the account's copy reads back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkErasePickup } from "@woco/shared/holding/pickup";
import { holdingPickupId, holdingPickupSigner } from "@woco/shared/holding/derive";
import { HoldingBoxRefusedError } from "@woco/shared/holding/open";
import { holdingGenKeysOf, readHoldingIndex } from "../src/lib/holding/account-copy.ts";
import { eraseServerCopy, keepInAccount, type KeepDeps } from "../src/lib/holding/keep.ts";
import { fetchHoldingBox, type BoxSourceDeps } from "../src/lib/holding/box-source.ts";
import { erasePickup, pickupHolding, type EraseResult, type PickupResult } from "../src/lib/api/holdings.ts";
import { fakeFeeds, makeBox, sealFor, secret } from "./holding-fixture.ts";

const R = secret(1);
const OTHER = secret(2);
const NOW = 1_800_000_000_000;
const ROOT_A = "aa".repeat(32);
const ROOT_B = "bb".repeat(32);

function deps(over: Partial<KeepDeps> & { feeds?: ReturnType<typeof fakeFeeds> } = {}) {
  const feeds = over.feeds ?? fakeFeeds();
  const erased: { pickupId: string; issuedAt: number; sig: string }[] = [];
  const d: KeepDeps = {
    io: feeds.io,
    erase: async (pickupId, issuedAt, sig) => (erased.push({ pickupId, issuedAt, sig }), "erased"),
    now: () => NOW,
    ...over,
  };
  return { d, erased, feeds };
}

// ── keep ─────────────────────────────────────────────────────────────────────

test("keep: saved and read back, THEN the erase - signed by the order's pickup key, in seconds", async () => {
  const keys = await holdingGenKeysOf(`0x${"31".repeat(32)}`);
  const { d, erased, feeds } = deps();
  assert.deepEqual(await keepInAccount(keys, R, makeBox(R, 2), d), { saved: "saved", erase: "erased" });
  assert.equal(erased.length, 1);
  const e = erased[0]!;
  assert.equal(e.pickupId, holdingPickupId(R));
  assert.equal(e.issuedAt, NOW / 1000);
  assert.ok(checkErasePickup({ pickupId: e.pickupId, issuedAt: e.issuedAt, signature: e.sig, expectedSigner: holdingPickupSigner(R).address, nowSecs: NOW / 1000 }));
  const index = await readHoldingIndex(keys, feeds.io);
  assert.ok(index && index !== "unavailable" && index.orders.length === 1, "saved before the erase was asked");
});

test("keep: a save that does not read back asks nothing of the server", async () => {
  const keys = await holdingGenKeysOf(`0x${"31".repeat(32)}`);
  for (const after of [0, 1]) {
    const { d, erased, feeds } = deps();
    feeds.unconfirmAfter = after;
    assert.deepEqual(await keepInAccount(keys, R, makeBox(R, 1), d), { saved: "unconfirmed", erase: "not-yet" });
    assert.equal(erased.length, 0);
  }
});

test("keep: a save that fails, or a box that is not this order's, erases nothing", async () => {
  const keys = await holdingGenKeysOf(`0x${"31".repeat(32)}`);
  const failing = deps();
  failing.feeds.failReads.add("*");
  failing.d.io = { ...failing.feeds.io, readBase: async () => { throw new Error("gateway down"); } };
  await assert.rejects(keepInAccount(keys, R, makeBox(R, 1), failing.d));
  assert.equal(failing.erased.length, 0);

  const wrong = deps();
  await assert.rejects(keepInAccount(keys, R, makeBox(OTHER, 1), wrong.d), (e: unknown) => e instanceof HoldingBoxRefusedError && e.reason === "not-this-order");
  assert.equal(wrong.erased.length, 0);
  assert.equal(wrong.feeds.writes.length, 0, "nothing saved either");
});

test("keep: every erase answer is passed on as it came", async () => {
  const keys = await holdingGenKeysOf(`0x${"31".repeat(32)}`);
  for (const answer of ["erased", "gone", "busy", "refused", "later"] as EraseResult[]) {
    const { d } = deps({ erase: async () => answer });
    assert.equal((await keepInAccount(keys, R, makeBox(R, 1), d)).erase, answer);
  }
});

test("erase alone: the statement verifies only for this order and inside the window", async () => {
  let got: { pickupId: string; issuedAt: number; sig: string } | null = null;
  await eraseServerCopy(R, { erase: async (pickupId, issuedAt, sig) => ((got = { pickupId, issuedAt, sig }), "erased"), now: () => NOW });
  assert.ok(got);
  const g = got as { pickupId: string; issuedAt: number; sig: string };
  const check = (signer: string, nowSecs: number) =>
    checkErasePickup({ pickupId: g.pickupId, issuedAt: g.issuedAt, signature: g.sig, expectedSigner: signer, nowSecs });
  assert.ok(check(holdingPickupSigner(R).address, NOW / 1000));
  assert.ok(!check(holdingPickupSigner(OTHER).address, NOW / 1000));
  assert.ok(!check(holdingPickupSigner(R).address, NOW / 1000 + 301));
});

// ── box source ───────────────────────────────────────────────────────────────

function source(over: { swarm?: Record<string, unknown>; pickup?: PickupResult }) {
  const asked: string[] = [];
  const picked: string[] = [];
  const d: BoxSourceDeps = {
    fromSwarm: async (root) => (asked.push(root), over.swarm?.[root] ?? null),
    pickup: async (id) => (picked.push(id), over.pickup ?? { kind: "not-found" }),
  };
  return { d, asked, picked };
}

test("box: Swarm first by its root, and the server is never asked when that works", async () => {
  const sealed = await sealFor(R, makeBox(R, 2));
  const s = source({ swarm: { [ROOT_A]: sealed } });
  const got = await fetchHoldingBox(R, ROOT_A, s.d);
  assert.equal(got.kind, "ok");
  assert.equal(got.kind === "ok" && got.boxRoot, ROOT_A);
  assert.deepEqual(got.kind === "ok" && got.receipts.map((c) => c.receipt.slot), [6, 7]);
  assert.deepEqual(s.asked, [ROOT_A]);
  assert.deepEqual(s.picked, []);
});

test("box: the server only when Swarm cannot serve it - inline while unstored, else its root from Swarm", async () => {
  const sealed = await sealFor(R, makeBox(R, 1));
  const inline = source({ pickup: { kind: "ok", boxRoot: ROOT_A, box: sealed as never } });
  const a = await fetchHoldingBox(R, ROOT_A, inline.d);
  assert.equal(a.kind, "ok");
  assert.deepEqual(inline.picked, [holdingPickupId(R)], "asked by the pickup id the secret gives");

  // No root in the link: the server names it, Swarm serves it.
  const named = source({ swarm: { [ROOT_B]: sealed }, pickup: { kind: "ok", boxRoot: ROOT_B } });
  const b = await fetchHoldingBox(R, undefined, named.d);
  assert.equal(b.kind === "ok" && b.boxRoot, ROOT_B);
  assert.deepEqual(named.asked, [ROOT_B]);
});

test("box: a box re-made after a replacement - the old root's box is refused, the new root's kept", async () => {
  const old = await sealFor(R, makeBox(OTHER, 1));
  const remade = await sealFor(R, makeBox(R, 1, 40));
  const s = source({ swarm: { [ROOT_A]: old, [ROOT_B]: remade }, pickup: { kind: "ok", boxRoot: ROOT_B } });
  const got = await fetchHoldingBox(R, ROOT_A, s.d);
  assert.equal(got.kind === "ok" && got.boxRoot, ROOT_B);
  assert.deepEqual(s.asked, [ROOT_A, ROOT_B]);
});

test("box: a refused box is the answer when nothing better turns up; the same root is never fetched twice", async () => {
  const wrong = await sealFor(R, makeBox(OTHER, 1));
  const gone = source({ swarm: { [ROOT_A]: wrong } });
  assert.deepEqual(await fetchHoldingBox(R, ROOT_A, gone.d), { kind: "refused", reason: "not-this-order" });

  const same = source({ swarm: { [ROOT_A]: wrong }, pickup: { kind: "ok", boxRoot: ROOT_A } });
  assert.deepEqual(await fetchHoldingBox(R, ROOT_A, same.d), { kind: "refused", reason: "not-this-order" });
  assert.deepEqual(same.asked, [ROOT_A]);

  const unopenable = source({ pickup: { kind: "ok", boxRoot: ROOT_A, box: { v: 2, enc: "00", ct: "00" } as never } });
  assert.deepEqual(await fetchHoldingBox(R, undefined, unopenable.d), { kind: "refused", reason: "unopenable" });
});

test("box: a malformed root is never fetched; the server is asked instead", async () => {
  const sealed = await sealFor(R, makeBox(R, 1));
  for (const bad of ["", "AA".repeat(32), "aa".repeat(31), `${ROOT_A}/../x`]) {
    const s = source({ swarm: { [bad]: sealed }, pickup: { kind: "ok", boxRoot: ROOT_B, box: sealed as never } });
    const got = await fetchHoldingBox(R, bad, s.d);
    assert.equal(got.kind === "ok" && got.boxRoot, ROOT_B, bad);
    assert.deepEqual(s.asked, [], bad);
  }
});

test("box: nothing anywhere - not found, or later when nobody could answer", async () => {
  assert.deepEqual(await fetchHoldingBox(R, ROOT_A, source({}).d), { kind: "not-found" });
  assert.deepEqual(await fetchHoldingBox(R, ROOT_A, source({ pickup: { kind: "later" } }).d), { kind: "later" });
  // The server names a root Swarm cannot serve.
  assert.deepEqual(await fetchHoldingBox(R, undefined, source({ pickup: { kind: "ok", boxRoot: ROOT_B } }).d), { kind: "later" });
});

// ── the calls ────────────────────────────────────────────────────────────────

async function withFetch<T>(reply: (url: string, init: RequestInit) => Response | Promise<Response>, run: () => Promise<T>) {
  const real = globalThis.fetch;
  const seen: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => (seen.push({ url, init }), reply(url, init))) as typeof fetch;
  try {
    return { out: await run(), seen };
  } finally {
    globalThis.fetch = real;
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("pickup: the id in the BODY, no session headers; each answer mapped", async () => {
  const id = holdingPickupId(R);
  const { out, seen } = await withFetch(() => json(200, { ok: true, data: { boxRoot: ROOT_A } }), () => pickupHolding(id));
  assert.deepEqual(out, { kind: "ok", boxRoot: ROOT_A });
  assert.ok(seen[0]!.url.endsWith("/api/holdings/pickup") && !seen[0]!.url.includes(id), "never in the URL");
  assert.deepEqual(JSON.parse(String(seen[0]!.init.body)), { pickupId: id });
  assert.deepEqual(Object.keys(seen[0]!.init.headers as Record<string, string>), ["Content-Type"], "no session headers");

  const box = await sealFor(R, makeBox(R, 1));
  assert.deepEqual((await withFetch(() => json(200, { ok: true, data: { boxRoot: ROOT_A, box } }), () => pickupHolding(id))).out, { kind: "ok", boxRoot: ROOT_A, box });
  assert.deepEqual((await withFetch(() => json(404, { ok: false }), () => pickupHolding(id))).out, { kind: "not-found" });
  for (const reply of [
    () => json(503, { ok: false }),
    () => json(429, { ok: false }),
    () => json(200, { ok: true, data: { boxRoot: "zz" } }),
    () => json(200, { ok: true, data: { boxRoot: ROOT_A, box: { v: 1 } } }),
    () => new Response("<html>", { status: 502 }),
    () => { throw new TypeError("offline"); },
  ]) {
    assert.deepEqual((await withFetch(reply, () => pickupHolding(id))).out, { kind: "later" });
  }
});

test("erase: the statement in the BODY, no session headers; each answer mapped", async () => {
  const id = holdingPickupId(R);
  const { out, seen } = await withFetch(() => json(200, { ok: true, data: { erased: true } }), () => erasePickup(id, 1_800_000_000, "0xsig"));
  assert.equal(out, "erased");
  assert.ok(seen[0]!.url.endsWith("/api/holdings/pickup/erase") && !seen[0]!.url.includes(id));
  assert.deepEqual(JSON.parse(String(seen[0]!.init.body)), { pickupId: id, issuedAt: 1_800_000_000, sig: "0xsig" });
  assert.deepEqual(Object.keys(seen[0]!.init.headers as Record<string, string>), ["Content-Type"]);
  for (const [status, want] of [[404, "gone"], [409, "busy"], [403, "refused"], [503, "later"], [429, "later"], [500, "later"]] as const) {
    assert.equal((await withFetch(() => json(status, { ok: false }), () => erasePickup(id, 1, "0x"))).out, want, String(status));
  }
  // A 200 that does not say "erased" is not one.
  assert.equal((await withFetch(() => json(200, { ok: true, data: {} }), () => erasePickup(id, 1, "0x"))).out, "later");
  assert.equal((await withFetch(() => { throw new TypeError("offline"); }, () => erasePickup(id, 1, "0x"))).out, "later");
});
