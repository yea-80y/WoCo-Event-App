/**
 * The cached-404 self-heal (lib/boot/self-heal.ts, #859). Background: 2026-10-15 a
 * phone kept 65 of the app's files as cached 404s from a postage outage, so the
 * dashboard stayed broken after every file was back on the gateway.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  HEAL_WINDOW_MS,
  MAX_HEAL_RELOADS,
  SELF_HEAL_KEY,
  SETTLE_MS,
  failedUrl,
  heal,
  healTargets,
  installSelfHeal,
  takeReload,
  type HealEnv,
} from "../src/lib/boot/self-heal.ts";

const BASE = "https://gateway.woco-net.com/bzz/6c2f1323739e50264f0a88c1c3c1f3fdc40c3b43d5c4337d16626957788db0a5/";
const A = `${BASE}assets/contract-BbwDz6Eo.js`;
const B = `${BASE}assets/index-By28DBhM.js`;
const CSS = `${BASE}assets/CreatorApp-Dq7bnTxk.css`;

class MemStorage {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
}
const store = () => new MemStorage() as unknown as Storage & MemStorage;

test("failedUrl: the URL Chrome, Firefox and Vite's CSS preload name; none for Safari", () => {
  assert.equal(failedUrl(new TypeError(`Failed to fetch dynamically imported module: ${A}`)), A);
  assert.equal(failedUrl(new TypeError(`error loading dynamically imported module: ${A}`)), A);
  assert.equal(failedUrl(new Error(`Unable to preload CSS for ${CSS}`)), CSS);
  assert.equal(failedUrl(new TypeError("Importing a module script failed.")), null);
  assert.equal(failedUrl({ message: `Failed to fetch dynamically imported module: ${A}` }), null, "not an Error");
  assert.equal(failedUrl(undefined), null);
});

test("healTargets: this build's .js/.css only, named first, deduped", () => {
  const got = healTargets(BASE, A, [
    A,
    B,
    CSS,
    "https://events-api.woco-net.com/api/swarm/soc/00d6/6c50?gatewayUrl=x", // an API call
    "https://gateway.woco-net.com/chunks/ec962b4f", // the build check's probe
    "https://gateway.woco-net.com/bzz/aaaa/assets/old-build.js", // another build
    "https://evil.example/bzz/6c2f1323739e50264f0a88c1c3c1f3fdc40c3b43d5c4337d16626957788db0a5/assets/x.js",
    `${BASE}assets/logo.png`,
    "not a url at all ::",
  ]);
  assert.deepEqual(got, [A, B, CSS]);
  assert.deepEqual(healTargets(BASE, "./assets/x.js", []), [`${BASE}assets/x.js`], "relative names resolve against the base");
  assert.deepEqual(healTargets("not a base", A, [A]), [], "no usable base, nothing to repair");
});

test("takeReload: a bounded budget per tab, refused when it cannot be recorded", () => {
  const s = store();
  for (let i = 0; i < MAX_HEAL_RELOADS; i++) assert.equal(takeReload(s, 1000 + i), true, `reload ${i + 1}`);
  assert.equal(takeReload(s, 2000), false, "budget spent");
  assert.equal(takeReload(s, 1000 + HEAL_WINDOW_MS + 1), true, "a new window after it elapses");
  assert.deepEqual(JSON.parse(s.getItem(SELF_HEAL_KEY)!), { since: 1000 + HEAL_WINDOW_MS + 1, reloads: 1 });

  const back = store();
  back.setItem(SELF_HEAL_KEY, JSON.stringify({ since: 5000, reloads: MAX_HEAL_RELOADS }));
  assert.equal(takeReload(back, 4000), true, "a clock that went backwards starts a new window");

  assert.equal(takeReload(null, 1), false, "no storage: no reload");
  const junk = store();
  junk.setItem(SELF_HEAL_KEY, "{not json");
  assert.equal(takeReload(junk, 1), false, "an unreadable record fails closed");
  const full = { getItem: () => null, setItem: () => { throw new Error("QuotaExceeded"); } } as unknown as Storage;
  assert.equal(takeReload(full, 1), false, "a record that cannot be written fails closed");
});

function env(over: Partial<HealEnv> & { back?: Set<string> } = {}) {
  const calls = { refetched: [] as string[], reloads: 0 };
  const s = store();
  const e: HealEnv = {
    base: () => BASE,
    failedResources: () => [],
    refetch: async (u) => {
      calls.refetched.push(u);
      return over.back ? over.back.has(u) : true;
    },
    storage: () => s,
    holdReload: () => false,
    reload: () => void calls.reloads++,
    now: () => 10_000,
    ...over,
  };
  return { e, calls, s };
}

test("heal: repairs every failed file of this build, then reloads once", async () => {
  const { e, calls } = env({ failedResources: () => [A, B, "https://events-api.woco-net.com/api/x"] });
  assert.equal(await heal(new TypeError(`Failed to fetch dynamically imported module: ${A}`), e), "reloaded");
  assert.deepEqual(calls.refetched, [A, B]);
  assert.equal(calls.reloads, 1);
});

test("heal: nothing of ours failed - no fetch, no reload", async () => {
  const { e, calls } = env({ failedResources: () => ["https://events-api.woco-net.com/api/x"] });
  assert.equal(await heal(new TypeError("Importing a module script failed."), e), "not-ours");
  assert.deepEqual(calls.refetched, []);
  assert.equal(calls.reloads, 0);
});

test("heal: a file that is really gone is never reloaded for", async () => {
  const { e, calls } = env({ back: new Set() });
  assert.equal(await heal(new TypeError(`Failed to fetch dynamically imported module: ${A}`), e), "still-missing");
  assert.equal(calls.reloads, 0);
  const thrown = env({ refetch: async () => { throw new TypeError("offline"); } });
  assert.equal(await heal(new TypeError(`Failed to fetch dynamically imported module: ${A}`), thrown.e), "still-missing");
  assert.equal(thrown.calls.reloads, 0);
});

test("heal: one file back is enough to reload", async () => {
  const { e, calls } = env({ failedResources: () => [B], back: new Set([B]) });
  assert.equal(await heal(new TypeError(`Failed to fetch dynamically imported module: ${A}`), e), "reloaded");
  assert.equal(calls.reloads, 1);
});

test("heal: when a reload could lose something, repair only - the app's own refresh prompt then works", async () => {
  const { e, calls } = env({ holdReload: () => true });
  assert.equal(await heal(new TypeError(`Failed to fetch dynamically imported module: ${A}`), e), "repaired");
  assert.deepEqual(calls.refetched, [A]);
  assert.equal(calls.reloads, 0);
});

test("heal: the reload budget stops a loop", async () => {
  const { e, calls } = env();
  const err = new TypeError(`Failed to fetch dynamically imported module: ${A}`);
  for (let i = 0; i < MAX_HEAL_RELOADS; i++) assert.equal(await heal(err, e), "reloaded");
  assert.equal(await heal(err, e), "limit");
  assert.equal(calls.reloads, MAX_HEAL_RELOADS);
});

// --- installSelfHeal, driven through a fake window ---------------------------------

function fakeWindow(opts: { resources?: string[]; ok?: boolean; href?: string; noObserver?: boolean } = {}) {
  const t = new EventTarget();
  const log = { fetched: [] as Array<{ url: string; cache?: string }>, reloads: 0 };
  class FakeObserver {
    constructor(private cb: (list: { getEntries(): unknown[] }) => void) {}
    observe(o: { type: string; buffered?: boolean }) {
      if (o.type !== "resource" || !o.buffered) return; // only a buffered observer sees what already failed
      const entries = [
        { name: `${BASE}assets/ok.js`, responseStatus: 200 },
        ...(opts.resources ?? []).map((name) => ({ name, responseStatus: 404 })),
      ];
      this.cb({ getEntries: () => entries });
    }
  }
  const w = Object.assign(t, {
    document: { baseURI: BASE },
    PerformanceObserver: opts.noObserver ? undefined : FakeObserver,
    fetch: async (url: string, init?: RequestInit) => {
      log.fetched.push({ url, cache: init?.cache });
      return { ok: opts.ok ?? true } as Response;
    },
    sessionStorage: store(),
    location: { href: opts.href ?? `${BASE}#/creator`, reload: () => void log.reloads++ },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  });
  return { w, log };
}

function preloadError(w: EventTarget, url: string) {
  const ev = new Event("vite:preloadError", { cancelable: true }) as Event & { payload?: unknown };
  ev.payload = new TypeError(`Failed to fetch dynamically imported module: ${url}`);
  w.dispatchEvent(ev);
}

const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS + 100));

async function withWindow<T>(w: unknown, fn: () => Promise<T>): Promise<T> {
  const g = globalThis as { window?: unknown };
  const prior = g.window;
  g.window = w;
  try {
    return await fn();
  } finally {
    g.window = prior;
  }
}

test("install: a failed lazy import is repaired past the cache and the page reloads once", async () => {
  const { w, log } = fakeWindow({ resources: [A, B] });
  await withWindow(w, async () => {
    installSelfHeal();
    installSelfHeal(); // a newer build handed over to runs it again
    preloadError(w, A);
    preloadError(w, B); // a sibling of the same route, same moment
    await settle();
  });
  assert.deepEqual(log.fetched, [{ url: A, cache: "reload" }, { url: B, cache: "reload" }]);
  assert.equal(log.reloads, 1);
});

test("install: once something was typed, it repairs but never reloads", async () => {
  const { w, log } = fakeWindow();
  await withWindow(w, async () => {
    installSelfHeal();
    w.dispatchEvent(new Event("input"));
    preloadError(w, A);
    await settle();
  });
  assert.deepEqual(log.fetched, [{ url: A, cache: "reload" }]);
  assert.equal(log.reloads, 0);
});

test("install: a later failure is healed again after the first one finished", async () => {
  const { w, log } = fakeWindow({ ok: false });
  await withWindow(w, async () => {
    installSelfHeal();
    preloadError(w, A);
    await settle();
    preloadError(w, B);
    await settle();
  });
  assert.deepEqual(log.fetched.map((f) => f.url), [A, B]);
  assert.equal(log.reloads, 0, "neither came back");
});

test("install: opened on a Web3Auth or Stripe return, it repairs but never reloads", async () => {
  for (const href of [
    // one marker each, so dropping any one from the rule fails here
    `https://woco.eth.limo/#/creator?b64Params=eyJ4IjoxfQ`,
    `https://woco.eth.limo/#sessionId=abc`,
    `https://woco.eth.limo/#/event/1?stripe=success`,
    `https://woco.eth.limo/#/event/1?x=1&session_id=cs_test_1`,
  ]) {
    const { w, log } = fakeWindow({ href });
    await withWindow(w, async () => {
      installSelfHeal();
      preloadError(w, A);
      await settle();
    });
    assert.deepEqual(log.fetched, [{ url: A, cache: "reload" }], href);
    assert.equal(log.reloads, 0, href);
  }
});

test("install: the base is read when the load fails, not after the settle", async () => {
  const NEW = "https://gateway.woco-net.com/bzz/1111111111111111111111111111111111111111111111111111111111111111/";
  const { w, log } = fakeWindow();
  w.document.baseURI = NEW; // a handover pointed the page at the new build
  await withWindow(w, async () => {
    installSelfHeal();
    preloadError(w, `${NEW}assets/main-new.js`);
    w.document.baseURI = BASE; // ...and restored the old base when it failed
    await settle();
  });
  assert.deepEqual(log.fetched.map((f) => f.url), [`${NEW}assets/main-new.js`]);
  assert.equal(log.reloads, 1);
});

test("install: with no PerformanceObserver it still heals the file the error names", async () => {
  const { w, log } = fakeWindow({ noObserver: true, resources: [B] });
  await withWindow(w, async () => {
    installSelfHeal();
    preloadError(w, A);
    await settle();
  });
  assert.deepEqual(log.fetched.map((f) => f.url), [A]);
  assert.equal(log.reloads, 1);
});

test("boot.ts installs it before the build check starts", () => {
  const src = readFileSync(new URL("../src/boot.ts", import.meta.url), "utf8");
  assert.match(src, /\ninstallSelfHeal\(\)\nvoid start\(\)\n$/);
});
