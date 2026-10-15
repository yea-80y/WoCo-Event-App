/**
 * The scanner store (runes + IndexedDB), compiled with Svelte and run in node
 * against fake IndexedDB, ONLINE: requests go to a programmable fake server. Shared
 * by the door entries and the after-the-event clean-up tests. Unlike
 * `scanner-store-switch.test.ts` (offline, one module swapped per gate), this one
 * also owns the clock, the store's intervals and its window/document listeners, so
 * a test can run the real refresh tick and the real "tab came back" handler.
 *
 * Only `sw-update.ts` is swapped (it imports the PWA plugin's virtual module).
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import type test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { base64UrlEncode, type CheckinPack, type DoorEntriesPage, type DoorEntryLogItem, type DoorEntryPlaintext } from "@woco/shared";
import { doorEntriesKeypair } from "@woco/shared/checkin/door-entries-key";
import { doorKeyRefOf } from "@woco/shared/checkin/door-keys";
import { doorEntrySealContext, sealBoxJson } from "@woco/shared/crypto/sealed-box";

const here = fileURLToPath(new URL(".", import.meta.url));
const scannerDir = join(here, "../src/lib/scanner");
const moduleUrl = (name: string) => pathToFileURL(join(scannerDir, name)).href;

/** The same module instance the compiled store imports, so the test's factory is the store's. */
export const db = (await import(moduleUrl("db.ts"))) as typeof import("../src/lib/scanner/db.js");

// ── the browser the store expects ───────────────────────────────────────────

export const page = { href: "https://scan.test/", reloads: 0 };
const fakeLocation = {
  get href() {
    return page.href;
  },
  get hash() {
    return new URL(page.href).hash;
  },
  get pathname() {
    return new URL(page.href).pathname;
  },
  get search() {
    return new URL(page.href).search;
  },
  reload() {
    page.reloads += 1;
  },
};

/** Listeners the store added, by event type ("visibilitychange", "focus", ...). */
export const listeners = new Map<string, Array<() => void>>();
const listening = {
  addEventListener(type: string, fn: () => void) {
    listeners.set(type, [...(listeners.get(type) ?? []), fn]);
  },
};
export const fakeDocument = { ...listening, visibilityState: "hidden" as "hidden" | "visible" };

/** The store's intervals; a test runs one by hand (`tick`). Never fire on their own. */
export const intervals = new Map<number, { fn: () => void; ms: number }>();
let nextInterval = 1;

/** Shifts the store's clock (Date.now) by this much. */
export const clock = { offsetMs: 0 };
const realNow = Date.now.bind(Date);

export type Handler = (url: URL, init: RequestInit | undefined) => Promise<Response> | Response;
/** The fake server: one handler per path suffix ("/pack", "/entries", "/sync", "/claim"). */
export const server = { handlers: new Map<string, Handler>(), requests: [] as { url: URL; headers: Record<string, string> }[] };

Object.assign(globalThis, {
  location: fakeLocation,
  history: { replaceState: (_s: unknown, _t: string, url: string) => (page.href = new URL(url, page.href).href) },
  window: listening,
  document: fakeDocument,
  fetch: async (input: string, init?: RequestInit) => {
    const url = new URL(input, "https://api.test");
    server.requests.push({ url, headers: { ...(init?.headers as Record<string, string> | undefined) } });
    const suffix = url.pathname.slice(url.pathname.lastIndexOf("/"));
    const handler = server.handlers.get(suffix);
    if (!handler) throw new TypeError("offline");
    return handler(url, init);
  },
  setInterval: (fn: () => void, ms: number) => {
    const id = nextInterval++;
    intervals.set(id, { fn, ms });
    return id;
  },
  clearInterval: (id: number) => intervals.delete(id),
});
Date.now = () => realNow() + clock.offsetMs;
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });

/** Run every store interval of `ms` once, as the browser would after that long. */
export function tick(ms: number): void {
  for (const { fn, ms: every } of [...intervals.values()]) if (every === ms) fn();
}

export function fire(type: string): void {
  for (const fn of listeners.get(type) ?? []) fn();
}

// ── the store, compiled ─────────────────────────────────────────────────────

const { compileModule } = await import("svelte/compiler");
const { transform } = await import("esbuild");
// Inside the package, so the compiled module resolves `svelte/internal/client`; removed after.
const out = mkdtempSync(join(here, "../node_modules/.scanner-store-online-"));
writeFileSync(join(out, "sw-update.js"), "export const takeoverIfNewer = () => Promise.resolve(false);\n");
const source = readFileSync(join(scannerDir, "store.svelte.ts"), "utf8").replace("import.meta.env.VITE_API_URL", '""');
const js = (await transform(source, { loader: "ts", format: "esm" })).code;
const compiled = compileModule(js, { generate: "client", filename: "store.svelte.js" }).js.code.replace(
  /from "\.\/([\w-]+)\.js"/g,
  (_m, name: string) => `from ${JSON.stringify(name === "sw-update" ? "./sw-update.js" : moduleUrl(`${name}.ts`))}`,
);
writeFileSync(join(out, "store.js"), compiled);
const storeUrl = pathToFileURL(join(out, "store.js")).href;

export function removeCompiledStore(): void {
  rmSync(out, { recursive: true, force: true });
}

export type Scanner = (typeof import("../src/lib/scanner/store.svelte.js"))["scanner"];
let instance = 0;

/** A fresh tab: a new store over the same storage. Its loops stop when the test ends. */
export async function openTab(t: test.TestContext): Promise<Scanner> {
  const scanner = ((await import(`${storeUrl}?tab=${++instance}`)) as { scanner: Scanner }).scanner;
  t.after(() => scanner.reprovision());
  return scanner;
}

/** Fresh storage, no server, the real clock, a hidden page. */
export function resetWorld(): void {
  db.useIndexedDbForTests(new IDBFactory());
  page.href = "https://scan.test/";
  page.reloads = 0;
  server.handlers.clear();
  server.requests.length = 0;
  intervals.clear();
  listeners.clear();
  clock.offsetMs = 0;
  fakeDocument.visibilityState = "hidden";
}

/** Settle background work the store started without awaiting (`void this.sync()`, ...). */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

// ── events, passes and the door entries a server would serve ────────────────

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;

export interface TestPass {
  eventId: string;
  jti: string;
  exp: number;
  token: string;
  keyB64url: string;
  secret: Uint8Array;
}

const b64url = (s: string) => Buffer.from(s).toString("base64url");

/** A pass whose token the scanner decodes like a real one (the server's tag is not checked on the phone). */
export function makePass(eventId: string, jti: string, exp = Math.floor(realNow() / 1000) + DAY / 1000): TestPass {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  return {
    eventId,
    jti,
    exp,
    token: `v1.${b64url(eventId)}.${jti}.${exp}.${"ab".repeat(32)}`,
    keyB64url: base64UrlEncode(secret),
    secret,
  };
}

export const seriesId = (eventId: string) => `ser-${eventId}`;

export function packFor(eventId: string, over: Partial<CheckinPack> = {}): CheckinPack {
  return {
    v: 1,
    eventId,
    eventTitle: eventId,
    eventDate: "2026-10-20T19:00:00.000Z",
    series: [{ seriesId: seriesId(eventId), name: "General", totalSupply: 10 }],
    checkins: [],
    generatedAt: "2026-10-14T18:00:00.000Z",
    doorMode: "single",
    ...over,
  };
}

/** A pass and pack as provisioning leaves them, written straight to storage. */
export async function storeEvent(pass: TestPass, pack: Partial<CheckinPack> = {}): Promise<void> {
  await db.putPass({ token: pass.token, keyB64url: pass.keyB64url, eventId: pass.eventId, exp: pass.exp });
  await db.putPack(packFor(pass.eventId, pack));
}

/** One event's door entries log, sealed as fulfilment seals it. */
export class EntriesLog {
  private seq = 0;
  readonly log: DoorEntryLogItem[] = [];
  constructor(readonly pass: TestPass, readonly sealTo: Uint8Array = doorEntriesKeypair(pass.secret).publicKey) {}

  get doorKeyRef(): string {
    return doorKeyRefOf(this.sealTo);
  }

  async add(edition: number, plain: Partial<DoorEntryPlaintext> = {}): Promise<this> {
    const series = seriesId(this.pass.eventId);
    const body: DoorEntryPlaintext = { v: 1, seriesId: series, edition, email: `buyer${edition}@example.com`, buyerName: `Card Holder ${edition}`, ...plain };
    const box = await sealBoxJson(this.sealTo, body, doorEntrySealContext(this.pass.eventId, this.pass.jti, series, edition));
    this.log.push({ seq: ++this.seq, kind: "add", seriesId: series, edition, box, at: "2026-10-14T20:00:00Z" });
    return this;
  }

  remove(edition: number): this {
    this.log.push({ seq: ++this.seq, kind: "remove", seriesId: seriesId(this.pass.eventId), edition, at: "2026-10-14T21:00:00Z" });
    return this;
  }

  /** What `readDoorEntriesPage` answers for `?since=`. */
  page(since: number, limit = 500): DoorEntriesPage {
    const lines = this.log.filter((l) => l.seq > since).slice(0, limit);
    const next = lines.at(-1)?.seq ?? since;
    return { jti: this.pass.jti, doorKeyRef: this.doorKeyRef, next, reset: false, more: this.log.some((l) => l.seq > next), log: lines };
  }

  /** A handler serving this log, `limit` lines per page. */
  handler(limit = 500): Handler {
    return (url) => Response.json({ ok: true, data: this.page(Number(url.searchParams.get("since") ?? "0"), limit) });
  }
}

export const okSync: Handler = () => Response.json({ ok: true, data: { checkins: [], conflicts: [] } });
