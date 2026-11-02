/**
 * The organiser dashboard shows new sales without a reload: it polls the cheap
 * order count while the page is in view, reads the full list only when the count
 * moves, and opens only the orders it has not opened yet - never asking for keys.
 *
 * Pure rules from `live-orders.ts`; the Svelte wiring by SOURCE SCAN (Node cannot
 * mount Svelte components).
 *
 * MUTATION: drop the visibility check, the in-flight guard, the count gate, the
 * box comparison, the session gate, the stored-session stop, the backoff or the
 * no-sign-in option anywhere on the request path, or open every order on each
 * poll, and a case below goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { OrderEntry } from "@woco/shared";
import {
  OpenedOrders,
  createOrdersPoller,
  pollDelay,
  ORDERS_POLL_MAX_MS,
  RECHECK_GAP_MS,
  type OrdersPollerDeps,
} from "../src/lib/creator/dashboard/live-orders.js";
import { sessionForRequest, signWithStoredSession } from "../src/lib/auth/request-session.js";

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
  const opened = new OpenedOrders<{ n: number }>();
  assert.equal(opened.remap([order("a", 1, "e1"), order("a", 2)]).size, 0);
});

test("an opened order follows its ticket when a sale shifts the positions", () => {
  const opened = new OpenedOrders<{ n: number }>();
  const b1 = order("b", 1, "eb1");
  opened.markOpened();
  opened.put(b1, { n: 7 });
  // A sale in an EARLIER series pushes b1 from position 0 to position 1.
  const map = opened.remap([order("a", 1, "ea1"), b1]);
  assert.equal(map.get(1)?.n, 7);
  assert.equal(map.has(0), false, "the new order is not opened yet");
});

test("only orders with a box not opened before are opened", () => {
  const opened = new OpenedOrders<{ n: number }>();
  const a1 = order("a", 1, "e1");
  opened.markOpened();
  opened.put(a1, { n: 1 });
  const todo = opened.unopened([a1, order("a", 2, "e2"), order("a", 3)]);
  assert.deepEqual(todo.map((t) => t.idx), [1]);
});

test("a re-sealed or erased order never shows an earlier opening", () => {
  const opened = new OpenedOrders<{ n: number }>();
  opened.markOpened();
  opened.put(order("a", 1, "old"), { n: 1 });
  const resealed = order("a", 1, "new");
  assert.equal(opened.remap([resealed]).has(0), false);
  assert.deepEqual(opened.unopened([resealed]).map((t) => t.idx), [0]);
  // Erased on request, or not fetched yet: no box at all - no entry, never the old details.
  assert.equal(opened.remap([order("a", 1)]).has(0), false);
});

test("a box that would not open is not tried again until it changes or the keys lock", () => {
  const opened = new OpenedOrders<{ n: number }>();
  const bad = order("a", 1, "e1");
  opened.markOpened();
  opened.fail(bad);
  assert.equal(opened.unopened([bad]).length, 0);
  assert.equal(opened.failures, 1);
  assert.equal(opened.unopened([order("a", 1, "e2")]).length, 1, "a re-sealed box is tried");
  opened.clear();
  assert.equal(opened.unopened([bad]).length, 1, "after a relock, tried again");
});

test("prune forgets what no row carries any more: an erased or re-sealed order's details go", () => {
  const opened = new OpenedOrders<{ n: number }>();
  opened.markOpened();
  const a1 = order("a", 1, "e1");
  const a2 = order("a", 2, "e2");
  opened.put(a1, { n: 1 });
  opened.put(a2, { n: 2 });
  opened.fail(order("a", 3, "e3"));
  // a1 erased (no box), a2 unchanged, a3 gone from the list.
  opened.prune([order("a", 1), a2]);
  assert.equal(opened.remap([a1, a2]).has(0), false, "a1's opened details are gone even if its old box came back");
  assert.equal(opened.remap([a1, a2]).get(1)?.n, 2);
  assert.equal(opened.failures, 0);
});

test("a row with no box gets no entry, even after opening (#965: rows arrive before boxes)", () => {
  const opened = new OpenedOrders<{ n: number }>();
  opened.markOpened();
  opened.put(order("a", 1, "e1"), { n: 1 });
  const map = opened.remap([order("a", 1, "e1"), order("a", 2)]);
  assert.equal(map.get(0)?.n, 1);
  assert.equal(map.has(1), false, "an entry would read as 'opened, no details' and hide the row's state");
});

test("locking again forgets everything opened", () => {
  const opened = new OpenedOrders<{ n: number }>();
  const a1 = order("a", 1, "e1");
  opened.markOpened();
  opened.put(a1, { n: 1 });
  opened.clear();
  assert.equal(opened.remap([a1]).size, 0);
  assert.equal(opened.unopened([a1]).length, 1);
  assert.equal(opened.remap([order("a", 2)]).size, 0);
});

test("the broadcast tab asks to open orders only when there are boxes to open", () => {
  assert.match(DASH, /\{#if decryptedOrders\.size === 0 && ordersResponse && ordersResponse\.orders\.some\(\(o\) => !!o\.encryptedOrder\)\}/);
});

// ── the poller ──────────────────────────────────────────────────────────────

function harness(opts: { count?: number; visible?: boolean; canRequest?: boolean; refreshOk?: boolean } = {}) {
  const state = {
    count: opts.count ?? 3,
    countFails: false,
    visible: opts.visible ?? true,
    canRequest: opts.canRequest ?? true,
    sessionStored: true,
    refreshOk: opts.refreshOk ?? true,
    now: 100_000,
    countCalls: 0,
    refreshCalls: 0,
    timers: new Map<number, number>(),
    callbacks: new Map<number, () => void>(),
    lastDelay: null as number | null,
    listeners: new Set<() => void>(),
    nextHandle: 1,
    countGate: null as null | Promise<void>,
  };
  const deps: OrdersPollerDeps = {
    intervalMs: 30_000,
    count: async () => {
      state.countCalls++;
      if (state.countGate) await state.countGate;
      if (state.countFails) throw new Error("rpc down");
      return state.count;
    },
    refresh: async () => {
      state.refreshCalls++;
      return state.refreshOk;
    },
    canRequest: () => state.canRequest,
    sessionStored: async () => state.sessionStored,
    isVisible: () => state.visible,
    onVisibilityChange: (cb) => {
      state.listeners.add(cb);
      return () => state.listeners.delete(cb);
    },
    setTimeout: (cb, ms) => {
      const h = state.nextHandle++;
      state.timers.set(h, ms);
      state.callbacks.set(h, cb);
      state.lastDelay = ms;
      return h;
    },
    clearTimeout: (h) => state.timers.delete(h as number),
    now: () => state.now,
  };
  const fire = () => [...state.listeners].forEach((cb) => cb());
  /** Let every pending timer go off, as the browser would. */
  const elapse = () => {
    const due = [...state.timers.keys()];
    for (const h of due) {
      const cb = state.callbacks.get(h);
      state.timers.delete(h);
      state.callbacks.delete(h);
      cb?.();
    }
  };
  return { state, deps, fire, elapse };
}

const settle = () => new Promise((r) => setImmediate(r));

test("polls only while the page is in view", async () => {
  const { state, deps, fire } = harness({ visible: false });
  const poller = createOrdersPoller(deps);
  poller.start(3);
  assert.equal(state.timers.size, 0, "a hidden page sets no timer");
  state.visible = true;
  fire();
  await settle();
  assert.equal(state.countCalls, 1, "coming into view checks at once");
  assert.equal(state.timers.size, 1, "and schedules the next check");
  state.visible = false;
  fire();
  assert.equal(state.timers.size, 0, "going out of view stops it");
});

test("coming back into view checks at once, and a focus right after does not check twice", async () => {
  const { state, deps, fire } = harness({ visible: false });
  const poller = createOrdersPoller(deps);
  poller.start(3);
  state.visible = true;
  fire();
  await settle();
  assert.equal(state.countCalls, 1);
  state.now += RECHECK_GAP_MS - 1;
  fire(); // the window's focus event right behind visibilitychange
  await settle();
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

test("no request without a session in memory - a poll never signs in", async () => {
  const { state, deps, elapse } = harness({ canRequest: false });
  const poller = createOrdersPoller(deps);
  poller.start(0);
  elapse();
  await settle();
  assert.equal(state.countCalls, 0);
  assert.equal(state.timers.size, 1, "it looks again later, still without a request");
});

test("the stored session gone (signed out elsewhere): the poller stops, and sends nothing", async () => {
  const { state, deps, fire } = harness({ count: 4 });
  const poller = createOrdersPoller(deps);
  poller.start(3);
  state.sessionStored = false;
  await poller.tick();
  assert.equal(state.countCalls, 0);
  assert.equal(state.refreshCalls, 0);
  assert.equal(state.timers.size, 0, "stopped, not skipped: no next check");
  assert.equal(state.listeners.size, 0);
  state.sessionStored = true;
  state.now += 60_000;
  fire();
  await poller.tick();
  assert.equal(state.countCalls, 0, "only a new page (a real sign-in) starts it again");
});

test("failures back off, doubling to five minutes, and one success resets it", async () => {
  assert.equal(pollDelay(30_000, 0), 30_000);
  assert.equal(pollDelay(30_000, 3), 240_000);
  assert.equal(pollDelay(30_000, 50), ORDERS_POLL_MAX_MS);
  const { state, deps } = harness({ count: 3 });
  const poller = createOrdersPoller(deps);
  poller.start(3);
  state.countFails = true;
  const delays: Array<number | null> = [];
  for (let i = 0; i < 5; i++) {
    await poller.tick();
    delays.push(state.lastDelay);
  }
  assert.deepEqual(delays, [60_000, 120_000, 240_000, 300_000, 300_000]);
  state.countFails = false;
  await poller.tick();
  assert.equal(poller.failures, 0);
  assert.equal(state.lastDelay, 30_000);
});

test("a failed full read backs off too", async () => {
  const { state, deps } = harness({ count: 4, refreshOk: false });
  const poller = createOrdersPoller(deps);
  poller.start(3);
  await poller.tick();
  assert.equal(poller.failures, 1);
  assert.equal(state.lastDelay, 60_000);
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
  while (state.countCalls === 0) await settle(); // the count request is out
  poller.stop();
  release();
  await inFlight;
  assert.equal(state.refreshCalls, 0, "no list shown on a page that is gone");
  assert.equal(state.timers.size, 0);
  assert.equal(state.listeners.size, 0);
});

// ── a background request never signs in (request-session.ts) ────────────────

function spies(o: { hasSession: boolean; signs: boolean }) {
  const calls = { ensureSession: 0, forget: 0, sign: 0 };
  return {
    calls,
    hasSession: () => o.hasSession,
    ensureSession: async () => {
      calls.ensureSession++;
      return true;
    },
    forget: () => {
      calls.forget++;
    },
    sign: async () => {
      calls.sign++;
      return o.signs ? "sig" : null;
    },
  };
}

test("establish: false never calls ensureSession - no session in memory", async () => {
  const d = spies({ hasSession: false, signs: true });
  assert.equal(await sessionForRequest(d, { establish: false }), false);
  assert.equal(d.calls.ensureSession, 0);
});

test("establish: false never calls ensureSession - the stored session is gone", async () => {
  const d = spies({ hasSession: true, signs: false });
  assert.equal(await signWithStoredSession(d, { establish: false }), null);
  assert.equal(d.calls.ensureSession, 0);
  assert.equal(d.calls.forget, 0, "and leaves the session state alone");
});

test("an ordinary request still establishes, as before", async () => {
  const lazy = spies({ hasSession: false, signs: true });
  assert.equal(await sessionForRequest(lazy), true);
  assert.equal(lazy.calls.ensureSession, 1);
  const stale = spies({ hasSession: true, signs: false });
  await signWithStoredSession(stale);
  assert.deepEqual(stale.calls, { ensureSession: 1, forget: 1, sign: 2 });
});

// ── the dashboard wiring (source scan) ──────────────────────────────────────

const DASH = readFileSync(new URL("../src/lib/creator/dashboard/Dashboard.svelte", import.meta.url), "utf-8");
const fnBody = (name: string) => {
  const start = DASH.indexOf(name);
  assert.notEqual(start, -1, `${name} is gone`);
  return DASH.slice(start, DASH.indexOf("\n  }\n", start));
};

test("polls the cheap count, gated on a session already here, and never signs in", () => {
  // #965: the count comes from the chain once the browser knows the registrations.
  assert.match(DASH, /count: async \(\) =>\s*\(await ordersReader\(\)\.reader\.count\(\)\.catch\(\(\) => null\)\) \?\? getEventOrderCount\(id, \{ establish: false \}\)/);
  assert.match(DASH, /const fresh = await loadOrders\(\{ establish: false \}\);/);
  // …and the option reaches both the browser read and the server fallback.
  assert.match(DASH, /return \(ordersLoad \?\?= readOrders\(opts\)\.finally/);
  const load = fnBody("async function readOrders");
  assert.match(load, /await reader\.loadRows\(opts\);/);
  assert.match(load, /const data = \(await getEventOrdersSWR\(eventId\)\.refresh\(opts\)\)\.data \?\? null;/);
  assert.match(DASH, /canRequest: \(\) => auth\.isConnected && auth\.hasSession/);
  assert.match(DASH, /sessionStored: async \(\) => \{\s*const parent = auth\.parent;\s*return !!parent && !!\(await getSessionDelegation\(parent\)\);/);
});

const CLIENT = readFileSync(new URL("../src/lib/api/client.ts", import.meta.url), "utf-8");
const STORE = readFileSync(new URL("../src/lib/auth/auth-store.svelte.ts", import.meta.url), "utf-8");
const EVENTS = readFileSync(new URL("../src/lib/api/events.ts", import.meta.url), "utf-8");
const SWR = readFileSync(new URL("../src/lib/api/creator-cache.ts", import.meta.url), "utf-8");

test("the no-sign-in option reaches signRequest, and stops the re-mint recovery", () => {
  assert.match(CLIENT, /const signed = await auth\.signRequest\(method, path, body, opts\);/);
  assert.match(CLIENT, /await buildAuthHeaders\(method, path, bodyText \?\? "", opts\)/);
  assert.match(CLIENT, /const json = await authFetch<T>\("GET", path, null, baseUrl, opts\);/);
  const fetchBody = CLIENT.slice(CLIENT.indexOf("async function authFetch<T>"), CLIENT.indexOf("export async function authPost"));
  const early = fetchBody.indexOf("if (opts.establish === false) return result;");
  const recover = fetchBody.indexOf("await recoverSession(generation);");
  assert.ok(early > 0 && early < recover, "a background request returns before the session is reset and re-sent");
  assert.match(EVENTS, /authGet<\{ eventId: string; count: number \}>\(`\/api\/events\/\$\{eventId\}\/orders\/count`, undefined, opts\)/);
  assert.match(EVENTS, /authGet<EventOrdersResponse>\(`\/api\/events\/\$\{eventId\}\/orders`, undefined, opts\)/);
  assert.match(SWR, /const data = await getEventOrders\(eventId, opts\);/);
});

test("signRequest decides sign-ins only through the helper, with the request's option", () => {
  const start = STORE.indexOf("async function signRequest(");
  const body = STORE.slice(start, STORE.indexOf("\n}\n", start));
  assert.match(body, /opts: RequestSigningOptions = \{\},/);
  assert.match(body, /sessionForRequest\(\{ hasSession: \(\) => hasSession, ensureSession \}, opts\)/);
  assert.match(body, /signWithStoredSession\(\s*\{[\s\S]*?ensureSession,\s*\},\s*opts,\s*\)/);
  assert.doesNotMatch(body, /await ensureSession\(\)/, "no direct sign-in left in signRequest");
});

test("a poll opens orders without ever asking", () => {
  const body = fnBody("async function refreshOrders");
  assert.match(body, /void decryptCurrent\(\);/);
  assert.doesNotMatch(body, /decryptCurrent\(true\)|ensureOrganiserUnlock|ensureAccountSetup/);
});

test("each run opens only what is not open yet", () => {
  const body = fnBody("async function openOrders");
  assert.match(body, /opened\.unopened\(ordersResponse\.orders\)/);
  assert.doesNotMatch(body, /ordersResponse\.orders\.map\(/);
});

test("the list and its display map change together, and opened details never outlive their box", () => {
  const body = fnBody("function showOrders");
  assert.match(body, /ordersResponse = fresh;\s*\/\/[^\n]*\n\s*opened\.prune\(fresh\.orders\);\s*decryptedOrders = opened\.remap\(fresh\.orders\);/);
  assert.doesNotMatch(DASH.replace(body, ""), /ordersResponse = (fresh|freshOrders|ordersSWR\.cached)/);
});

test("locking again clears what was opened", () => {
  assert.match(DASH, /opened\.clear\(\);\s*decryptedOrders = new Map\(\);\s*ordersLocked = true;/);
});

test("polling starts from a real read (or its failure, to retry it), never from the cached paint", () => {
  assert.match(DASH, /showOrders\(freshOrders\);\s*ordersFromServer = true;/);
  assert.match(DASH, /const liveReady = \$derived\(\(ordersFromServer \|\| ordersReadError !== null\) && !error && !!event\)/);
  const cachedPaint = DASH.slice(DASH.indexOf("showOrders(ordersSWR.cached)"), DASH.indexOf("// ── Step 2"));
  assert.doesNotMatch(cachedPaint, /ordersFromServer = true|ordersReadError =/);
  // After a failed first read no count can match, so the first check reads again.
  assert.match(DASH, /poller\.start\(untrack\(\(\) => \(ordersReadError !== null \? -1 :/);
});

test("opening runs in steps from the rows on screen, gives the page a turn, and a relock mid-run keeps nothing", () => {
  const body = fnBody("async function openOrders");
  assert.match(body, /const epoch = openEpoch;/);
  // Each step from the live rows: an order erased mid-run is never opened (Fable sign-off S2).
  assert.match(body, /const batch = ordersResponse \? opened\.unopened\(ordersResponse\.orders\)\.slice\(0, OPEN_CHUNK\) : \[\];/);
  assert.match(body, /else opened\.fail\(batch\[k\]\.order\);/, "a box that would not open is not retried every run (S6)");
  assert.match(body, /await new Promise\(\(resolve\) => setTimeout\(resolve, 0\)\);/);
  const guard = body.indexOf("if (epoch !== openEpoch || destroyed) return;");
  assert.ok(guard > 0 && guard < body.indexOf("opened.put("), "the lock check comes before anything opened is kept");
  assert.match(DASH, /openEpoch\+\+;\s*opener\?\.lock\(\);\s*opened\.clear\(\);/);
});

test("every way out of an opening run stops showing 'Opening...' (Fable sign-off S5)", () => {
  const body = fnBody("async function decryptOnce");
  assert.match(body, /decrypting = true;\s*try \{\s*await openOrders\(prompt\);\s*\} finally \{\s*\/\/[^\n]*\n\s*decrypting = false;/);
});

test("nothing opens for a dashboard that has gone (Fable sign-off M1)", () => {
  assert.match(fnBody("async function decryptOnce"), /if \(destroyed \|\| !ordersResponse\) return;/);
  assert.match(DASH, /\$effect\(\(\) => \(\) => \{\s*destroyed = true;\s*openEpoch\+\+;\s*browserOrders\?\.queue\.stop\(\);\s*if \(rebuildTimer !== null\) clearTimeout\(rebuildTimer\);/);
  assert.match(DASH, /if \(destroyed \|\| ordersSource !== "browser" \|\| !browserOrders \|\| !ordersResponse\) return;/);
  assert.match(fnBody("async function refreshOrders"), /if \(destroyed \|\| !fresh \|\| !event\) return false;/);
});

test("a retry that succeeds after a failed first read keeps polling on (Fable sign-off M2)", () => {
  assert.match(fnBody("async function refreshOrders"), /showOrders\(fresh\);\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*ordersFromServer = true;/);
});

test("rows show where their details stand, never the ticket's single-use key", () => {
  assert.match(DASH, /\{:else if dec\}\s*\{order\.claimerAddress\.slice\(0, 6\)\}/);
  assert.match(DASH, /<span class="claim-type">\{detailLabel\(order\)\}<\/span>/);
  assert.doesNotMatch(DASH, /orders\.indexOf\(order\)/, "no per-row scan of the whole list");
});
