/**
 * The organiser dashboard shows new sales without a reload: it polls the cheap
 * order count while the page is in view, reads the full list only when the count
 * moves, and opens only the orders it has not opened yet - never asking for keys.
 *
 * Pure rules from `live-orders.ts`; the Svelte wiring by SOURCE SCAN (Node cannot
 * mount Svelte components).
 *
 * MUTATION: drop the visibility check, the in-flight guard, the count gate, the
 * box comparison or the session gate, or open every order on each poll, and a
 * case below goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { OrderEntry } from "@woco/shared";
import {
  OpenedOrders,
  createOrdersPoller,
  RECHECK_GAP_MS,
  type OrdersPollerDeps,
} from "../src/lib/creator/dashboard/live-orders.js";

const order = (seriesId: string, edition: number, enc?: string): OrderEntry =>
  ({
    seriesId,
    seriesName: seriesId,
    edition,
    claimerAddress: "0x1",
    claimedAt: "",
    ...(enc ? { encryptedOrder: { v: 2, enc, ct: "00" } } : {}),
  }) as unknown as OrderEntry;

// ── OpenedOrders ────────────────────────────────────────────────────────────

test("nothing shows before the keys opened anything", () => {
  const opened = new OpenedOrders<{ n: number }>(() => ({ n: 0 }));
  assert.equal(opened.remap([order("a", 1, "e1"), order("a", 2)]).size, 0);
});

test("an opened order follows its ticket when a sale shifts the positions", () => {
  const opened = new OpenedOrders<{ n: number }>(() => ({ n: 0 }));
  const b1 = order("b", 1, "eb1");
  opened.markOpened();
  opened.put(b1, { n: 7 });
  // A sale in an EARLIER series pushes b1 from position 0 to position 1.
  const map = opened.remap([order("a", 1, "ea1"), b1]);
  assert.equal(map.get(1)?.n, 7);
  assert.equal(map.has(0), false, "the new order is not opened yet");
});

test("only orders with a box not opened before are opened", () => {
  const opened = new OpenedOrders<{ n: number }>(() => ({ n: 0 }));
  const a1 = order("a", 1, "e1");
  opened.markOpened();
  opened.put(a1, { n: 1 });
  const todo = opened.unopened([a1, order("a", 2, "e2"), order("a", 3)]);
  assert.deepEqual(todo.map((t) => t.idx), [1]);
});

test("a re-sealed or erased order never shows an earlier opening", () => {
  const opened = new OpenedOrders<{ n: number }>(() => ({ n: 0 }));
  opened.markOpened();
  opened.put(order("a", 1, "old"), { n: 1 });
  const resealed = order("a", 1, "new");
  assert.equal(opened.remap([resealed]).has(0), false);
  assert.deepEqual(opened.unopened([resealed]).map((t) => t.idx), [0]);
  // Erased on request: no box at all - an empty entry, not the old details.
  assert.deepEqual(opened.remap([order("a", 1)]).get(0), { n: 0 });
});

test("locking again forgets everything opened", () => {
  const opened = new OpenedOrders<{ n: number }>(() => ({ n: 0 }));
  const a1 = order("a", 1, "e1");
  opened.markOpened();
  opened.put(a1, { n: 1 });
  opened.clear();
  assert.equal(opened.remap([a1]).size, 0);
  assert.equal(opened.unopened([a1]).length, 1);
  // Not even an empty entry for an order with no box: an entry reads as "unlocked".
  assert.equal(opened.remap([order("a", 2)]).size, 0);
});

// ── the poller ──────────────────────────────────────────────────────────────

function harness(opts: { count?: number; visible?: boolean; canRequest?: boolean; refreshOk?: boolean } = {}) {
  const state = {
    count: opts.count ?? 3,
    visible: opts.visible ?? true,
    canRequest: opts.canRequest ?? true,
    refreshOk: opts.refreshOk ?? true,
    now: 100_000,
    countCalls: 0,
    refreshCalls: 0,
    intervals: new Set<number>(),
    listeners: new Set<() => void>(),
    nextHandle: 1,
    countGate: null as null | Promise<void>,
  };
  const deps: OrdersPollerDeps = {
    intervalMs: 30_000,
    count: async () => {
      state.countCalls++;
      if (state.countGate) await state.countGate;
      return state.count;
    },
    refresh: async () => {
      state.refreshCalls++;
      return state.refreshOk;
    },
    canRequest: () => state.canRequest,
    isVisible: () => state.visible,
    onVisibilityChange: (cb) => {
      state.listeners.add(cb);
      return () => state.listeners.delete(cb);
    },
    setInterval: () => {
      const h = state.nextHandle++;
      state.intervals.add(h);
      return h;
    },
    clearInterval: (h) => state.intervals.delete(h as number),
    now: () => state.now,
  };
  const fire = () => [...state.listeners].forEach((cb) => cb());
  return { state, deps, fire };
}

test("polls only while the page is in view", () => {
  const { state, deps, fire } = harness({ visible: false });
  const poller = createOrdersPoller(deps);
  poller.start(3);
  assert.equal(state.intervals.size, 0, "a hidden page sets no timer");
  state.visible = true;
  fire();
  assert.equal(state.intervals.size, 1, "coming into view starts the timer");
  state.visible = false;
  fire();
  assert.equal(state.intervals.size, 0, "going out of view stops it");
});

test("coming back into view checks at once, and a focus right after does not check twice", async () => {
  const { state, deps, fire } = harness({ visible: false });
  const poller = createOrdersPoller(deps);
  poller.start(3);
  state.visible = true;
  fire();
  await new Promise((r) => setImmediate(r));
  assert.equal(state.countCalls, 1);
  state.now += RECHECK_GAP_MS - 1;
  fire(); // the window's focus event right behind visibilitychange
  await new Promise((r) => setImmediate(r));
  assert.equal(state.countCalls, 1);
});

test("the full list is read only when the count moves", async () => {
  const { state, deps } = harness({ count: 3 });
  const poller = createOrdersPoller(deps);
  poller.start(3);
  await poller.tick();
  assert.equal(state.refreshCalls, 0, "same count: no full read");
  state.count = 4;
  await poller.tick();
  assert.equal(state.refreshCalls, 1);
  await poller.tick();
  assert.equal(state.refreshCalls, 1, "the new count is the mark now");
});

test("a failed full read is retried on the next tick", async () => {
  const { state, deps } = harness({ count: 4, refreshOk: false });
  const poller = createOrdersPoller(deps);
  poller.start(3);
  await poller.tick();
  state.refreshOk = true;
  await poller.tick();
  assert.equal(state.refreshCalls, 2);
});

test("no request without a session already on this device - a poll never signs in", async () => {
  const { state, deps } = harness({ canRequest: false });
  const poller = createOrdersPoller(deps);
  poller.start(0);
  await poller.tick();
  assert.equal(state.countCalls, 0);
});

test("a hidden page does not check even if the timer fires", async () => {
  const { state, deps } = harness();
  const poller = createOrdersPoller(deps);
  poller.start(0);
  state.visible = false;
  await poller.tick();
  assert.equal(state.countCalls, 0);
});

test("one check at a time", { timeout: 5_000 }, async () => {
  const { state, deps } = harness({ count: 4 });
  let release!: () => void;
  state.countGate = new Promise((r) => (release = r));
  const poller = createOrdersPoller(deps);
  poller.start(3);
  const first = poller.tick();
  const second = poller.tick();
  release();
  await Promise.all([first, second]);
  assert.equal(state.countCalls, 1);
  assert.equal(state.refreshCalls, 1);
});

test("leaving the page stops everything, including a check already under way", { timeout: 5_000 }, async () => {
  const { state, deps } = harness({ count: 4 });
  let release!: () => void;
  state.countGate = new Promise((r) => (release = r));
  const poller = createOrdersPoller(deps);
  poller.start(3);
  const inFlight = poller.tick();
  poller.stop();
  release();
  await inFlight;
  assert.equal(state.refreshCalls, 0, "no list shown on a page that is gone");
  assert.equal(state.intervals.size, 0);
  assert.equal(state.listeners.size, 0);
});

// ── the dashboard wiring (source scan) ──────────────────────────────────────

const DASH = readFileSync(new URL("../src/lib/creator/dashboard/Dashboard.svelte", import.meta.url), "utf-8");
const fnBody = (name: string) => {
  const start = DASH.indexOf(name);
  assert.notEqual(start, -1, `${name} is gone`);
  return DASH.slice(start, DASH.indexOf("\n  }\n", start));
};

test("polls the cheap count, gated on a session already here", () => {
  assert.match(DASH, /count: \(\) => getEventOrderCount\(id\)/);
  assert.match(DASH, /canRequest: \(\) => auth\.isConnected && auth\.hasSession/);
});

test("a poll opens orders without ever asking", () => {
  const body = fnBody("async function refreshOrders");
  assert.match(body, /void decryptCurrent\(\);/);
  assert.doesNotMatch(body, /decryptCurrent\(true\)|ensureOrganiserUnlock|ensureAccountSetup/);
});

test("each run opens only what is not open yet", () => {
  const body = fnBody("async function decryptOnce");
  assert.match(body, /opened\.unopened\(ordersResponse\.orders\)/);
  assert.doesNotMatch(body, /ordersResponse\.orders\.map\(/);
});

test("the list and its display map change together", () => {
  const body = fnBody("function showOrders");
  assert.match(body, /ordersResponse = fresh;\s*decryptedOrders = opened\.remap\(fresh\.orders\);/);
  assert.doesNotMatch(DASH.replace(body, ""), /ordersResponse = (fresh|freshOrders|ordersSWR\.cached)/);
});

test("locking again clears what was opened", () => {
  assert.match(DASH, /opened\.clear\(\);\s*decryptedOrders = new Map\(\);\s*ordersLocked = true;/);
});

test("polling starts from the server's list, never from the cached paint", () => {
  assert.match(DASH, /showOrders\(freshOrders\);\s*ordersFromServer = true;/);
  assert.match(DASH, /const liveReady = \$derived\(ordersFromServer && !error && !!event\)/);
  const cachedPaint = DASH.slice(DASH.indexOf("showOrders(ordersSWR.cached)"), DASH.indexOf("// ── Step 2"));
  assert.doesNotMatch(cachedPaint, /ordersFromServer = true/);
});
