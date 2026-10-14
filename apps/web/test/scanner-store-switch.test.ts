/**
 * The scanner store itself (runes + IndexedDB), compiled with Svelte and run in
 * node against fake IndexedDB, for the cases a source match cannot show: what a
 * tab does when it moves between events (Fable sign-off, 2026-10-14).
 *
 * Only two of its modules are swapped: `sw-update.ts` (it imports the PWA
 * plugin's virtual module) for a stub, and `verify.ts` for the real verifier
 * behind a gate the test opens, so a scan can be held between verify and admit.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { buildTicketCanonicalMessage, parseDoorPassFragment } from "@woco/shared";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { EVENT_CHANGED_MESSAGE } from "../src/lib/scanner/admission.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const scannerDir = join(here, "../src/lib/scanner");
const moduleUrl = (name: string) => pathToFileURL(join(scannerDir, name)).href;

// The same module instance the compiled store imports, so the test's factory is the store's.
const db = (await import(moduleUrl("db.ts"))) as typeof import("../src/lib/scanner/db.js");

// ── the browser the store expects ───────────────────────────────────────────

const page = { href: "https://scan.test/", reloads: 0 };
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
const ignore = { addEventListener() {} };
Object.assign(globalThis, {
  location: fakeLocation,
  history: { replaceState: (_s: unknown, _t: string, url: string) => (page.href = new URL(url, page.href).href) },
  window: ignore,
  document: { ...ignore, visibilityState: "hidden" },
  // Offline: nothing reaches a server, and a "single" pass admits from its own set.
  fetch: () => Promise.reject(new TypeError("offline")),
});
Object.defineProperty(globalThis, "navigator", { value: { onLine: false }, configurable: true });

// ── the store, compiled ─────────────────────────────────────────────────────

const { compileModule } = await import("svelte/compiler");
const { transform } = await import("esbuild");
// Inside the package, so the compiled module resolves `svelte/internal/client`; removed after.
const out = mkdtempSync(join(here, "../node_modules/.scanner-store-"));
test.after(() => rmSync(out, { recursive: true, force: true }));

writeFileSync(join(out, "sw-update.js"), "export const takeoverIfNewer = () => Promise.resolve(false);\n");
writeFileSync(
  join(out, "verify.js"),
  `import { verifyTicket as real } from ${JSON.stringify(moduleUrl("verify.ts"))};
export async function verifyTicket(raw, pack) {
  await globalThis.__scannerVerifyGate?.();
  return real(raw, pack);
}
`,
);

const source = readFileSync(join(scannerDir, "store.svelte.ts"), "utf8").replace("import.meta.env.VITE_API_URL", '""');
const js = (await transform(source, { loader: "ts", format: "esm" })).code;
const compiled = compileModule(js, { generate: "client", filename: "store.svelte.js" }).js.code.replace(
  /from "\.\/([\w-]+)\.js"/g,
  (_m, name: string) =>
    `from ${JSON.stringify(name === "sw-update" || name === "verify" ? `./${name}.js` : moduleUrl(`${name}.ts`))}`,
);
writeFileSync(join(out, "store.js"), compiled);
const storeUrl = pathToFileURL(join(out, "store.js")).href;

type Scanner = (typeof import("../src/lib/scanner/store.svelte.js"))["scanner"];
let instance = 0;
/** A fresh tab: a new store over the same storage. Its timers stop when the test ends. */
async function openTab(t: test.TestContext): Promise<Scanner> {
  const scanner = ((await import(`${storeUrl}?tab=${++instance}`)) as { scanner: Scanner }).scanner;
  t.after(() => scanner.reprovision());
  return scanner;
}

// ── events on the phone ─────────────────────────────────────────────────────

const EXP = Math.floor(Date.now() / 1000) + 24 * 3600;
const b64url = (s: string) => Buffer.from(s).toString("base64url");
const token = (eventId: string) => `v1.${b64url(eventId)}.jti0000000000001.${EXP}.${"ab".repeat(32)}`;

async function storeEvent(eventId: string, pack: Record<string, unknown> = {}) {
  await db.putPass({ token: token(eventId), keyB64url: `key-${eventId}`, eventId, exp: EXP });
  await db.putPack({
    v: 1,
    eventId,
    eventTitle: eventId,
    eventDate: "2026-10-20T19:00:00.000Z",
    series: [],
    checkins: [],
    generatedAt: "2026-10-14T18:00:00.000Z",
    doorMode: "single",
    ...pack,
  } as never);
}

const hasPassInUrl = () => parseDoorPassFragment(new URL(page.href).hash) !== null;

test.beforeEach(() => {
  db.useIndexedDbForTests(new IDBFactory());
  page.href = "https://scan.test/";
  page.reloads = 0;
});

test("a pass link that failed never comes back after the tab opens a stored event", async (t) => {
  await storeEvent("event-b");
  const scanner = await openTab(t);

  assert.equal(await scanner.provision(token("event-a"), "key-event-a"), false, "offline: the link cannot be set up");
  assert.ok(scanner.pendingPass, "held for Try again");

  assert.equal(await scanner.openEvent("event-b"), true);
  assert.equal(scanner.pendingPass, null, "opening a stored event lets the failed link go");

  scanner.newVersionReady(); // a quiet door: reloads into the new version at once
  assert.equal(page.reloads, 1);
  assert.ok(!hasPassInUrl(), "the reload does not carry the failed pass, which boot would set up over this event");
});

test("reset lets a failed pass link go too", async (t) => {
  await storeEvent("event-b");
  const scanner = await openTab(t);
  await scanner.openEvent("event-b");
  await scanner.provision(token("event-a"), "key-event-a");
  assert.ok(scanner.pendingPass);

  await scanner.reset();
  assert.equal(scanner.pendingPass, null);
  scanner.newVersionReady();
  assert.ok(!hasPassInUrl());
});

// ── a scan held between verify and admit ────────────────────────────────────

const ONCHAIN = ("0x" + "11".repeat(32)) as `0x${string}`;
const burner = privateKeyToAccount(generatePrivateKey());
const seriesOf = (eventId: string, owners: string[] = []) =>
  [{ seriesId: `ser-${eventId}`, name: "General", totalSupply: 10, onChainEventId: ONCHAIN, slotOwners: owners }];

/** A genuine ticket: edition 1 of event-a, signed by the burner its pack names as the slot's owner. */
async function ticketForEventA(): Promise<string> {
  const sig = await burner.signMessage({ message: buildTicketCanonicalMessage({ onChainEventId: ONCHAIN, seriesId: "ser-event-a", edition: 1 }) });
  return `woco://t/event-a/ser-event-a/1/${sig}`;
}

type Gated = typeof globalThis & { __scannerVerifyGate?: () => Promise<void> };

/** Holds the next verification until `release`; `reached` resolves once it is held. */
function holdVerification(t: test.TestContext) {
  let release!: () => void;
  let arrive!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const reached = new Promise<void>((r) => (arrive = r));
  (globalThis as Gated).__scannerVerifyGate = () => {
    arrive();
    return held;
  };
  t.after(() => delete (globalThis as Gated).__scannerVerifyGate);
  return { reached, release };
}

async function twoSingleScannerEvents() {
  await storeEvent("event-a", { series: seriesOf("event-a", [burner.address]) });
  await storeEvent("event-b", { series: seriesOf("event-b") });
}

async function assertNothingRecorded(scanner: Scanner) {
  for (const eventId of ["event-a", "event-b"]) {
    assert.deepEqual(await db.getAllCheckins(eventId), [], `no check-in under ${eventId}`);
    assert.deepEqual(await db.getPending(eventId), [], `nothing queued to sync under ${eventId}`);
  }
  assert.equal(scanner.checkins.size, 0);
}

test("a held scan with no switch admits under its own event", async (t) => {
  await twoSingleScannerEvents();
  const scanner = await openTab(t);
  await scanner.openEvent("event-a");
  const gate = holdVerification(t);
  const scanning = scanner.scan(await ticketForEventA());
  await gate.reached;
  gate.release();
  assert.equal((await scanning).kind, "checked-in");
  assert.deepEqual((await db.getAllCheckins("event-a")).map((r) => r.edition), [1]);
});

test("a scan that began under one event never admits under the event the tab switched to", async (t) => {
  await twoSingleScannerEvents();
  const scanner = await openTab(t);
  await scanner.openEvent("event-a");
  const gate = holdVerification(t);
  const scanning = scanner.scan(await ticketForEventA());
  await gate.reached; // verifying against event-a's pack
  await scanner.switchTo("event-b");
  assert.equal(scanner.pass?.eventId, "event-b");
  gate.release();

  const outcome = await scanning;
  assert.deepEqual(
    outcome,
    { kind: "cant-confirm", message: EVENT_CHANGED_MESSAGE, seriesName: "General", edition: 1 },
    "not admitted: the door it began at is no longer this tab's",
  );
  await assertNothingRecorded(scanner);
});
