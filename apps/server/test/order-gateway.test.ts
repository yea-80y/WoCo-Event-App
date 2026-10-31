/**
 * Our gateway serves every stored attendee order and never an erased one (#965):
 * the organiser's browser is to fetch sealed orders itself, so the proxy's list
 * must follow the attendee ledger in both directions. A listing that misses an
 * order shows "details unavailable"; a delisting that misses an erasure keeps an
 * erased order readable through us. Neither would show up as an error.
 *
 * MUTATION: drop the store hook, move the burn's delist after the first chunk,
 * drop the re-check after listing, list before delisting in the reconcile, let it
 * list an erased record or one whose erasure has started, let two runs overlap,
 * or remove the stamper gate at boot, and a case below goes red.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet, concat, getBytes, keccak256 } from "ethers";

process.chdir(mkdtempSync(join(tmpdir(), "woco-order-gateway-")));
process.env.FEED_PRIVATE_KEY = "33".repeat(32);
process.env.PROXY_URL = "http://proxy.test";
process.env.UPLOAD_SECRET = "s".repeat(32);

const ledger = await import("../src/lib/attendee-batch/ledger.js");
const writer = await import("../src/lib/attendee-batch/writer.js");
const burn = await import("../src/lib/attendee-batch/burn.js");
const gw = await import("../src/lib/attendee-batch/order-gateway.js");
const { attendeeBatchHealth } = await import("../src/lib/attendee-batch/health.js");
const wl = await import("../src/lib/swarm/whitelist.js");
const { stamperKeyFromHex } = await import("../src/lib/attendee-batch/stamp.js");

const STAMPER = stamperKeyFromHex("44".repeat(32));
const STAMPER_ADDRESS = new Wallet(`0x${"44".repeat(32)}`).address.toLowerCase();
ledger.registerBatch("ab".repeat(32), 20, STAMPER_ADDRESS, true, new Date(Date.now() + 30 * 86400_000).toISOString());
ledger.setActiveBatch("ab".repeat(32));

function chunkAddress(body: Uint8Array): string {
  const data = new Uint8Array(4096);
  data.set(body.slice(8));
  let level: Uint8Array[] = [];
  for (let i = 0; i < 4096; i += 32) level.push(data.slice(i, i + 32));
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(getBytes(keccak256(concat([level[i], level[i + 1]]))));
    level = next;
  }
  return keccak256(concat([body.slice(0, 8), level[0]])).slice(2);
}

let seed = 0;
async function storeOrder(list?: (root: string) => Promise<void>): Promise<string> {
  const payload = new TextEncoder().encode(`order-${++seed}-${Date.now()}`);
  return writer.storeAttendeePayload(payload, { kind: "checkout", eventId: "e1" }, {
    stamper: () => STAMPER,
    upload: async (_env, body) => chunkAddress(body),
    ...(list ? { list } : {}),
  });
}

/** A fake proxy list: what it holds, and every call in order. */
function fakeProxy(initial: string[] = []) {
  const present = new Set(initial);
  const calls: string[] = [];
  const deps: import("../src/lib/attendee-batch/order-gateway.js").OrderGatewayDeps = {
    list: async () => new Set(present),
    add: async (hashes) => {
      calls.push(`add:${hashes.join(",")}`);
      for (const h of hashes) present.add(h);
    },
    remove: async (hash) => {
      calls.push(`remove:${hash}`);
      present.delete(hash);
    },
  };
  return { present, calls, deps };
}

function planWholeBurn(root: string): void {
  const record = ledger.getOrderRecord(root)!;
  for (const c of record.chunks) ledger.planChunkBurn(root, c.address);
}

beforeEach(() => gw._resetOrderGatewayForTests());

test("a stored order is listed by the store itself", async () => {
  const listed: string[] = [];
  const root = await storeOrder(async (r) => void listed.push(r));
  assert.deepEqual(listed, [root]);
  assert.equal(ledger.getOrderRecord(root)?.state, "stored");
});

test("an erasure that lands while the listing is in flight wins", async () => {
  const root = await storeOrder();
  const proxy = fakeProxy();
  const add = proxy.deps.add;
  proxy.deps.add = async (hashes) => {
    planWholeBurn(root);
    await add(hashes);
  };
  await gw.listOrderRoot(root, proxy.deps);
  assert.deepEqual(proxy.calls, [`add:${root}`, `remove:${root}`]);
  assert.equal(proxy.present.has(root), false);
});

test("a failed listing or delisting never throws: the store and the erasure go on", async () => {
  const failing = { list: async () => new Set<string>(), add: async () => { throw new Error("proxy down"); }, remove: async () => { throw new Error("proxy down"); } };
  await gw.listOrderRoot("aa".repeat(32), failing);
  await gw.delistOrderRoot("aa".repeat(32), failing);
});

test("a burn delists the order before its first chunk is burned", async () => {
  const root = await storeOrder();
  const events: string[] = [];
  await burn.burnOrder(root, {
    stamper: () => STAMPER,
    upload: async (burner) => {
      events.push("burn");
      return keccak256(concat([burner.identifier, burner.owner])).slice(2);
    },
    delist: async (r) => void events.push(`delist:${r}`),
  });
  assert.equal(events[0], `delist:${root}`);
  assert.ok(events.length > 1 && events.slice(1).every((e) => e === "burn"));
});

test("the reconcile delists erased orders first, then lists stored ones, and touches nothing else", async () => {
  const stored = await storeOrder();
  const erased = await storeOrder();
  planWholeBurn(erased);
  const tombstone = "cd".repeat(32);
  ledger.recordErasedBeforeStore(tombstone, { eventId: "e1" });
  const unrelated = "ef".repeat(32);
  const proxy = fakeProxy([erased, unrelated, tombstone]);

  const out = await gw.reconcileOrderGateway(proxy.deps);

  const removes = proxy.calls.filter((c) => c.startsWith("remove:"));
  const firstAdd = proxy.calls.findIndex((c) => c.startsWith("add:"));
  assert.ok(removes.includes(`remove:${erased}`) && removes.includes(`remove:${tombstone}`));
  assert.ok(firstAdd > proxy.calls.lastIndexOf(removes[removes.length - 1]), "every delisting before any listing");
  assert.ok(proxy.present.has(stored), "the stored order is listed");
  assert.ok(proxy.present.has(unrelated), "a hash the ledger does not name is left alone");
  assert.equal(proxy.present.has(erased), false);
  assert.equal(proxy.present.has(tombstone), false);
  assert.ok(out && out.delisted >= 2 && out.listed >= 1);
});

test("an order whose erasure has started is never listed, before any chunk is planned", async () => {
  const root = await storeOrder();
  ledger.noteErasure(root, { by: "request" });
  assert.equal(ledger.isOrderErased(root), false, "nothing burned yet");
  const proxy = fakeProxy([root]);
  await gw.reconcileOrderGateway(proxy.deps);
  assert.equal(proxy.present.has(root), false);
  assert.ok(!proxy.calls.some((c) => c.startsWith("add:") && c.includes(root)));
});

test("an erasure that starts while the reconcile is listing is taken back", async () => {
  const proxy = fakeProxy();
  await gw.reconcileOrderGateway(proxy.deps);
  const racing = await storeOrder();
  proxy.calls.length = 0;
  const add = proxy.deps.add;
  proxy.deps.add = async (hashes) => {
    if (hashes.includes(racing)) ledger.noteErasure(racing, { by: "retention" });
    await add(hashes);
  };
  const out = await gw.reconcileOrderGateway(proxy.deps);
  assert.equal(proxy.present.has(racing), false, "listed, then delisted once the erasure was seen");
  assert.ok(proxy.calls.indexOf(`remove:${racing}`) > proxy.calls.findIndex((c) => c.includes(racing) && c.startsWith("add:")));
  assert.deepEqual(out, { listed: 0, delisted: 1 });
});

test("a reconcile that finds the list right changes nothing", async () => {
  const proxy = fakeProxy();
  await gw.reconcileOrderGateway(proxy.deps);
  proxy.calls.length = 0;
  assert.deepEqual(await gw.reconcileOrderGateway(proxy.deps), { listed: 0, delisted: 0 });
  assert.deepEqual(proxy.calls, []);
});

test("no proxy configured: nothing to do", async () => {
  const out = await gw.reconcileOrderGateway({ list: async () => null, add: async () => assert.fail("add"), remove: async () => assert.fail("remove") });
  assert.equal(out, null);
});

test("hourly, and again on the next tick after a failure, which health shows", async () => {
  let lists = 0;
  let fail = true;
  const deps = {
    list: async () => {
      lists++;
      if (fail) throw new Error("proxy down");
      return new Set<string>(ledger.listOrders().map((o) => o.root));
    },
    add: async () => {},
    remove: async () => {},
  };
  const t0 = Date.now();
  await assert.rejects(gw.tickOrderGateway(t0, deps));
  assert.equal(attendeeBatchHealth().checks.gatewayList.ok, false);
  fail = false;
  await gw.tickOrderGateway(t0 + 5 * 60_000, deps);
  assert.equal(lists, 2, "a failure is retried on the next tick, not in an hour");
  assert.equal(attendeeBatchHealth().checks.gatewayList.ok, true);
  await gw.tickOrderGateway(t0 + 30 * 60_000, deps);
  assert.equal(lists, 2, "no second run inside the hour");
  await gw.tickOrderGateway(t0 + 66 * 60_000, deps);
  assert.equal(lists, 3);
});

test("a slow run is never overlapped by the next tick", async () => {
  let lists = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const deps = {
    list: async () => {
      lists++;
      await gate;
      return new Set<string>(ledger.listOrders().map((o) => o.root));
    },
    add: async () => {},
    remove: async () => {},
  };
  const first = gw.tickOrderGateway(Date.now(), deps);
  await gw.tickOrderGateway(Date.now() + 5 * 60_000, deps);
  assert.equal(lists, 1, "the second tick returned while the first was still running");
  release();
  await first;
});

test("the proxy client: DELETE one hash, GET the whole list, both with the secret", async () => {
  const seen: Array<{ url: string; method: string; secret: string | null }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(input), method: init?.method ?? "GET", secret: headers.get("x-upload-secret") });
    return new Response(JSON.stringify({ hashes: ["AB".repeat(32)], count: 1 }), { status: 200 });
  }) as typeof fetch;
  try {
    await wl.unwhitelistHash("CD".repeat(32));
    const list = await wl.listWhitelist();
    assert.deepEqual([...(list ?? [])], ["ab".repeat(32)]);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(seen, [
    { url: `http://proxy.test/admin/whitelist/${"cd".repeat(32)}`, method: "DELETE", secret: "s".repeat(32) },
    { url: "http://proxy.test/admin/whitelist", method: "GET", secret: "s".repeat(32) },
  ]);
});

test("the boot wiring edits the list only on a server that owns an attendee batch", () => {
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(index, /const tickGateway = \(\) => \{\s*if \(!getAttendeeStamper\(\)\) return;\s*tickOrderGateway\(\)/);
  assert.match(index, /setInterval\(tickGateway, 5 \* 60_000\)\.unref\(\);/);
});

test("the live store and burn paths carry the hooks", () => {
  const writerSrc = readFileSync(new URL("../src/lib/attendee-batch/writer.ts", import.meta.url), "utf8");
  const burnSrc = readFileSync(new URL("../src/lib/attendee-batch/burn.ts", import.meta.url), "utf8");
  assert.match(writerSrc, /const liveDeps: StoreAttendeeDeps = \{ stamper: getAttendeeStamper, upload: liveChunkUploader, list: listOrderRoot \};/);
  assert.match(burnSrc, /const liveDeps: BurnDeps = \{ stamper: getAttendeeStamper, upload: liveBurnerUploader, delist: delistOrderRoot \};/);
});
