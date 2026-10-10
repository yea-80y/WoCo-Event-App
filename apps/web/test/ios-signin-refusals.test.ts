/**
 * What a refused passkey ceremony is told (an iPhone, 2026-10-09). The browser
 * says NotAllowedError for a cancelled sheet, for a ceremony it would not start
 * (no gesture it accepts, another ceremony pending, an app's embedded browser) and
 * for the fallback assertion after a creation that gave no secret. One sentence
 * for all three sent a person whose passkey HAD been created to make another, and
 * one whose prompt never opened to "try again" with no idea why.
 *
 * Runs the REAL passkey-account code; only the authenticator, the clock,
 * `window.location` and IndexedDB are shimmed (same shims as passkey-prf-at-create).
 *
 * MUTATION: drop the try/catch around the fallback get() in `prfAfterCreate` and
 * "created without its secret" goes red; drop the timing in `browserCeremony` and
 * both "no sheet" tests go red; swap the noSheet branch in PasskeyLogin below the
 * noAssertion one and the wiring test goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// --- minimal in-memory IndexedDB
function installFakeIndexedDB() {
  const data = new Map<string, unknown>();
  const stores = new Set<string>();
  const fire = (req: Record<string, unknown>, result?: unknown) =>
    queueMicrotask(() => {
      req.result = result;
      (req.onsuccess as ((e: unknown) => void) | undefined)?.({ target: req });
    });
  const objectStore = () => ({
    get: (k: string) => { const req: Record<string, unknown> = {}; fire(req, data.has(k) ? data.get(k) : undefined); return req; },
    put: (v: unknown, k: string) => { const req: Record<string, unknown> = {}; data.set(k, v); fire(req); return req; },
    delete: (k: string) => { const req: Record<string, unknown> = {}; data.delete(k); fire(req); return req; },
    clear: () => { const req: Record<string, unknown> = {}; data.clear(); fire(req); return req; },
  });
  const db = {
    objectStoreNames: { contains: (n: string) => stores.has(n) },
    createObjectStore: (n: string) => { stores.add(n); return {}; },
    transaction: () => ({ objectStore }),
    onclose: null,
  };
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open: () => {
      const req: Record<string, unknown> = {};
      queueMicrotask(() => {
        req.result = db;
        (req.onupgradeneeded as ((e: unknown) => void) | undefined)?.({ target: req });
        (req.onsuccess as ((e: unknown) => void) | undefined)?.({ target: req });
      });
      return req;
    },
  };
}

const RAW_ID = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
const PRF = new Uint8Array(32).fill(7);

/** The scripted clock: how long each browser call appears to take. */
let now = 0;
let callTakesMs = 0;
Object.defineProperty(globalThis, "performance", { value: { now: () => now }, configurable: true, writable: true });

/** What the authenticator does, per test: a credential, or a refusal. */
let createOutcome: "credential" | "refuse" = "credential";
let getOutcome: "credential" | "refuse" = "credential";
let createExt: Record<string, unknown> = {};

const refuse = () => new DOMException("Operation failed.", "NotAllowedError");

Object.defineProperty(globalThis, "navigator", {
  value: {
    credentials: {
      create: async () => {
        now += callTakesMs;
        if (createOutcome === "refuse") throw refuse();
        return {
          rawId: RAW_ID.buffer.slice(0) as ArrayBuffer,
          authenticatorAttachment: "platform",
          getClientExtensionResults: () => createExt,
        };
      },
      get: async () => {
        now += callTakesMs;
        if (getOutcome === "refuse") throw refuse();
        return {
          rawId: RAW_ID.buffer.slice(0) as ArrayBuffer,
          authenticatorAttachment: "platform",
          response: { userHandle: null },
          getClientExtensionResults: () => ({ prf: { results: { first: PRF } } }),
        };
      },
    },
  },
  configurable: true,
  writable: true,
});
(globalThis as { window?: unknown }).window = { location: { hostname: "localhost" } };
installFakeIndexedDB();

const {
  createPasskeyAccount,
  authenticatePasskey,
  PasskeyCeremonyCancelledError,
  PasskeyCreatedWithoutSecretError,
  PasskeyAssertionUnavailableError,
  PROMPT_DID_NOT_OPEN_MESSAGE,
  isQuickRefusal,
} = await import("../src/lib/auth/passkey-account.ts");

function reset(o: { create?: typeof createOutcome; get?: typeof getOutcome; ms?: number; createExt?: Record<string, unknown> }) {
  createOutcome = o.create ?? "credential";
  getOutcome = o.get ?? "credential";
  callTakesMs = o.ms ?? 3000;
  createExt = o.createExt ?? {};
}

test("a creation refused after a sheet (seconds) keeps the cancelled-or-not-permitted wording", async () => {
  reset({ create: "refuse", ms: 3000 });
  await assert.rejects(createPasskeyAccount(), (e: unknown) => {
    assert.ok(e instanceof PasskeyCeremonyCancelledError);
    assert.equal(e.noSheet, false);
    assert.equal(e.message, "Passkey creation was cancelled or not permitted by your device.");
    assert.ok(isQuickRefusal(e.cause) === false);
    return true;
  });
});

test("a creation refused before any sheet could open says the prompt did not open", async () => {
  reset({ create: "refuse", ms: 20 });
  await assert.rejects(createPasskeyAccount(), (e: unknown) => {
    assert.ok(e instanceof PasskeyCeremonyCancelledError);
    assert.equal(e.noSheet, true);
    assert.equal(e.message, PROMPT_DID_NOT_OPEN_MESSAGE);
    assert.match(e.message, /Safari or Chrome/, "names the way out of an app's built-in browser");
    return true;
  });
});

test("created, but the fallback assertion for its secret was refused: said as that, never as a cancelled creation", async () => {
  // No PRF at creation (a third-party password manager), then the second ceremony
  // - run long after the tap - is refused.
  reset({ createExt: {}, get: "refuse", ms: 20 });
  await assert.rejects(createPasskeyAccount(), (e: unknown) => {
    assert.ok(e instanceof PasskeyCreatedWithoutSecretError);
    assert.match(e.message, /was created/);
    assert.match(e.message, /Sign in with Passkey/, "the passkey they have is the way to finish");
    assert.ok(!(e instanceof PasskeyCeremonyCancelledError));
    return true;
  });
  // The same after a sheet the person dismissed: still the created passkey's story.
  reset({ createExt: {}, get: "refuse", ms: 3000 });
  await assert.rejects(createPasskeyAccount(), PasskeyCreatedWithoutSecretError);
});

test("a sign-in refused before any sheet is not 'you may have cancelled', and offers no create", async () => {
  reset({ get: "refuse", ms: 20 });
  await assert.rejects(authenticatePasskey(), (e: unknown) => {
    assert.ok(e instanceof PasskeyAssertionUnavailableError);
    assert.equal(e.noSheet, true);
    assert.equal(e.message, PROMPT_DID_NOT_OPEN_MESSAGE);
    return true;
  });
  reset({ get: "refuse", ms: 3000 });
  await assert.rejects(authenticatePasskey(), (e: unknown) => {
    assert.ok(e instanceof PasskeyAssertionUnavailableError);
    assert.equal(e.noSheet, false);
    assert.match(e.message, /You may have cancelled/);
    return true;
  });
});

test("the quick-refusal mark is per error object and only for NotAllowedError", async () => {
  assert.equal(isQuickRefusal(new DOMException("x", "NotAllowedError")), false, "unmarked until a ceremony saw it");
  assert.equal(isQuickRefusal(null), false);
  assert.equal(isQuickRefusal("NotAllowedError"), false);
});

// --- wiring ----------------------------------------------------------------------

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

test("the passkey button reads 'no sheet' before 'no assertion', so a prompt that never opened offers no create", () => {
  const button = read("../src/lib/components/auth/PasskeyLogin.svelte");
  const noSheet = button.indexOf("} else if (res.noSheet) {");
  const noAssertion = button.indexOf('} else if (res.noAssertion && mode === "signin") {');
  assert.ok(noSheet > 0 && noAssertion > noSheet);
  assert.ok(!button.slice(noSheet, noAssertion).includes("offerCreate = true"));
  const store = read("../src/lib/auth/auth-store.svelte.ts");
  assert.ok(store.includes("noSheet: (err as { noSheet?: boolean }).noSheet === true,"));
});

test("closing the sign-in sheet mid-attempt cancels the Web3Auth pop-up wait, and the hook never outlives the attempt", () => {
  const modal = read("../src/lib/components/auth/LoginModal.svelte");
  const close = modal.indexOf("function close() {");
  assert.ok(modal.slice(close, modal.indexOf("function handleComplete()")).includes("if (authing) auth.cancelLogin();"));
  const store = read("../src/lib/auth/auth-store.svelte.ts");
  const start = store.indexOf("async function loginWeb3Auth(");
  const fn = store.slice(start, store.indexOf("\nfunction cancelLogin()", start));
  const armed = fn.indexOf("_cancelLogin = cancelWeb3AuthSignIn;");
  const awaited = fn.indexOf("await loginWithWeb3Auth();", armed);
  const disarmed = fn.indexOf("_cancelLogin = null;", awaited);
  assert.ok(armed > 0 && awaited > armed && disarmed > awaited, "armed for the pop-up wait only");
  assert.ok(fn.slice(fn.indexOf("} finally {")).includes("_cancelLogin = null;"), "cleared however the attempt ends");
  assert.ok(store.includes("\n  cancelLogin,\n"), "exposed to the sheet");
});
