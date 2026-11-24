/**
 * The automatic collection's live wiring (slice 3c PR 2), pinned on its source where a
 * behaviour test would need the whole store: when it runs, what it may never do (prompt,
 * sign in, save under keys not confirmed, save mid-upgrade), and that the deployed-site
 * builds never carry it. Plus the two small rules with no I/O of their own.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const STORE = src("../src/lib/auth/auth-store.svelte.ts");
const LIVE = src("../src/lib/holding/collect-live.ts");
const IO = src("../src/lib/holding/holding-io.ts");
const API = src("../src/lib/api/holdings.ts");
const KEEP_CARD = src("../src/lib/attendee/keep/KeepCard.svelte");
const PASSPORT = src("../src/lib/attendee/passport/PassportTab.svelte");
const MARKS = src("../src/lib/holding/marks.ts");
const UPGRADE = src("../src/lib/auth/upgrade-to-passkey-live.ts");

function fn(text: string, sig: string): string {
  const start = text.indexOf(sig);
  assert.ok(start >= 0, `${sig} must exist`);
  return text.slice(start, text.indexOf("\n}\n", start));
}

test("the store never imports the collection: the main app registers it, so site bundles do not carry it", () => {
  assert.doesNotMatch(STORE, /import\(["'][^"']*collect(-live)?\.js["']\)/, "no dynamic import");
  assert.doesNotMatch(STORE, /^import [^;]*holding\/collect/m);
  const main = src("../src/main.ts");
  assert.match(main, /auth\.registerReceiptCollector\(\(\) => import\('\.\/lib\/holding\/collect-live\.js'\)\)/);
  assert.ok(main.indexOf("auth.registerReceiptCollector(") < main.indexOf("mount(App"), "registered before the app boots");
  for (const entry of ["../src/multi-site-main.ts", "../src/site-main.ts"]) {
    assert.doesNotMatch(src(entry), /registerReceiptCollector|collect-live/, entry);
  }
});

test("a run is asked for when the keys are confirmed, when an email account's seed is in, and when a session appears", () => {
  const soon = fn(STORE, "function _collectReceiptsSoon(");
  assert.match(soon, /if \(!_receiptCollector \|\| !FEATURES\.holdingReceiptsAllowed\) return;/, "dark while the flag is off");
  assert.match(soon, /setTimeout\(/);
  assert.match(fn(STORE, "function _commitSigner("), /_collectReceiptsSoon\(\);$/, "last, after the confirmed signer is committed");
  const eager = fn(STORE, "async function _establishFeedSignerEagerly(");
  assert.ok(eager.indexOf("await _getContentFeedSigner({ silent: true });") < eager.indexOf("_collectReceiptsSoon();"), "only once the seed is in");
  const session = fn(STORE, "async function ensureSession(");
  assert.ok(session.indexOf("_sessionAddress = sessionAddress;") < session.indexOf("_collectReceiptsSoon();"));
  assert.match(STORE, /registerReceiptCollector,/);
});

test("a run asks for nothing: flag, kind, a session already here, keys confirmed silently, no upgrade half done, one at a time", () => {
  const run = fn(LIVE, "export async function collectInBackground(");
  assert.match(run, /if \(!FEATURES\.holdingReceiptsAllowed\) return null;/);
  assert.match(run, /kind !== "passkey" && kind !== "web3auth"\) \|\| !auth\.hasSession\) return null;/);
  assert.match(run, /if \(receiptSavesPaused\(parent, kind\)\) return null;/);
  assert.match(run, /ifLockFree\(`woco:holding:collect:\$\{parent\}`/);
  // Sealing keys: the confirmed CURRENT generation, never the catch-up prompt.
  assert.match(run, /auth\.getAccountSecrets\(\{ toSeal: true, silent: true \}\)\.catch\(\(\) => null\)/);
  assert.doesNotMatch(run, /ensureAccountSetup|ensureSession|ensureIdentitySeed|loginRequest|toSeal: true \}\)/, "never a prompt or a sign-in");
  // Right before the first save or erase: the same account and secret, and one fresh anchor read.
  const still = run.slice(run.indexOf("async stillCurrent()"));
  assert.match(still, /if \(!bound\(\)\) return false;/);
  assert.match(still, /again\.current !== sealing\.current\) return false;/);
  assert.match(still, /ringRead \?\?= auth\.keyRingStillCurrent\(\)\.catch\(\(\) => false\);/, "one anchor read per run");
  assert.match(still, /return \(await ringRead\) && bound\(\);/, "the cheap checks every time");
  // The bound check covers a sign-out, another account, a relock and an upgrade begun meanwhile.
  assert.match(run, /auth\.seedAddress === seedAddress && auth\.hasSession && !receiptSavesPaused\(parent, auth\.kind\)/);
  assert.match(run, /for \(const g of gens\) g\.orderSecretKey\.fill\(0\);/);
});

test("the list call is signed and never starts a sign-in", () => {
  assert.match(API, /authPost<\{ holdings\?: unknown; complete\?: unknown \}>\(path, \{\}, undefined, \{ establish: false \}\)/);
  // The Keep page's two calls still carry no session.
  for (const sig of ["export async function pickupHolding(", "export async function erasePickup("]) {
    assert.doesNotMatch(fn(API, sig), /authPost|client\.js/, sig);
  }
});

test("receipt saves take turns per copy signer across tabs, and a beaten save waits at random", async () => {
  assert.match(IO, /withWebLock\(`woco:holding:save:\$\{owner\.toLowerCase\(\)\}`, save,/);
  assert.match(IO, /onSuperseded: \(\) => new Promise\(\(resolve\) => setTimeout\(resolve, holdingSaveBackoffMs\(\)\)\)/);
  const { holdingSaveBackoffMs } = await import("../src/lib/holding/holding-io.ts");
  assert.equal(holdingSaveBackoffMs(() => 0), 500);
  assert.equal(holdingSaveBackoffMs(() => 0.999999), 2_999);
  for (let i = 0; i < 50; i++) {
    const ms = holdingSaveBackoffMs();
    assert.ok(ms >= 500 && ms < 3_000);
  }
});

test("the Keep page refuses a save under the email account's keys while an upgrade is half done", () => {
  const save = KEEP_CARD.slice(KEEP_CARD.indexOf("async function save()"), KEEP_CARD.indexOf("async function eraseAgain()"));
  const paused = save.indexOf("pause.receiptSavesPaused(account, auth.kind)");
  assert.ok(paused > 0 && paused < save.indexOf("flow.saveToAccount("), "checked before the save");
  assert.match(save, /problem = pause\.RECEIPT_SAVES_PAUSED_MESSAGE;\s*return;/);
});

test("saves pause only for an email account with a PREPARED upgrade marker on this device", async () => {
  const store = new Map<string, string>();
  const was = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  try {
    const { receiptSavesPaused } = await import("../src/lib/holding/upgrade-pause.ts");
    const { upgradeMarkerKey } = await import("../src/lib/auth/upgrade-marker.ts");
    const parent = "0x1111111111111111111111111111111111111111";
    const marker = (stage: string) =>
      JSON.stringify({
        v: 1,
        parent,
        emailKey: "0x2222222222222222222222222222222222222222",
        oldFeedSigner: "0x5555555555555555555555555555555555555555",
        passkey: "0x3333333333333333333333333333333333333333",
        credential: { credentialId: "c", rpId: "r" },
        stage,
        likes: [],
        follows: [],
        retracted: false,
      });
    assert.equal(receiptSavesPaused(parent, "web3auth"), false, "no marker");
    store.set(upgradeMarkerKey(parent), marker("prepared"));
    assert.equal(receiptSavesPaused(parent, "web3auth"), true);
    assert.equal(receiptSavesPaused(parent.toUpperCase().replace("0X", "0x"), "web3auth"), true, "any case");
    assert.equal(receiptSavesPaused(parent, "passkey"), false, "the passkey's own seed is where receipts go");
    store.set(upgradeMarkerKey(parent), marker("committed"));
    assert.equal(receiptSavesPaused(parent, "web3auth"), false);
    assert.equal(receiptSavesPaused("0x9999999999999999999999999999999999999999", "web3auth"), false, "another account's marker");
  } finally {
    (globalThis as { localStorage?: unknown }).localStorage = was;
  }
});

test("the per-ticket mark: read without a prompt, only with the account's keys here, every generation, never written", () => {
  const read = fn(MARKS, "export async function readReceiptMarks(");
  assert.match(read, /auth\.getAccountSecrets\(\)\.catch\(\(\) => null\)/, "no toSeal: opening needs no confirm, and asks for nothing");
  assert.doesNotMatch(read, /ensure|toSeal|loginRequest|write/i);
  assert.match(read, /held\.all\.map\(\(s\) => holdingGenKeysOf\(s\)\)/);
  assert.match(read, /listHeldOrders\(gens, liveHoldingFeedIO\)/);
  assert.match(read, /for \(const g of gens\) g\.orderSecretKey\.fill\(0\);/);
  // Profile > Tickets reads them only while the keys are here, and again after a collection saved something.
  const effect = PASSPORT.slice(PASSPORT.indexOf("$effect(() => {\n    void receiptsChanged.n;"));
  assert.match(effect, /if \(!FEATURES\.holdingReceiptsAllowed \|\| !parent \|\| !auth\.hasIdentitySeed\) return;/);
  assert.match(PASSPORT, /receiptSaved=\{receiptSaved\(ticket\)\}/);
});

test("the upgrade reads the old seed's uncollected sales whole, over the email session, dark while the flag is off", () => {
  const read = UPGRADE.slice(UPGRADE.indexOf("readPending: async (oldSeed) => {"), UPGRADE.indexOf("writeReceipts: async"));
  assert.match(read, /if \(!FEATURES\.holdingReceiptsAllowed\) return \[\];/);
  assert.match(read, /pendingCopies\(\{ mine: \(\) => mineHoldings\(\), gens: \[gen\], fetchBox:/);
  assert.match(read, /gen\.orderSecretKey\.fill\(0\);/);
  assert.doesNotMatch(read, /erase|keepInAccount|saveHoldingCopy/, "reads only: our copy stays until the passkey's own collection");
});
