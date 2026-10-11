/**
 * iPhone passkey setup (a friend's iPhone 17, 2026-10-10/11): her AutoFill list
 * showed only Google Passwords, because Apple's Passwords app had been deleted, so
 * Create opened iOS's "Choose how to manage your passkeys" sheet. Reinstalling the
 * app fixed it. This pins:
 *  - the pre-check that names the fix BEFORE Create (`passkey-readiness.ts`);
 *  - the setup steps, in order, in every iPhone message;
 *  - a creation whose password manager says outright it has no PRF
 *    (`prf.enabled === false`): refused at once, naming the manager, with no
 *    second prompt that would read "sign in to finish" for a passkey that never can.
 *
 * MUTATIONS (each red, then restored): drop the `enabled === false` refusal in
 * `prfAfterCreate` (1 fail); count a MISSING `extension:prf` as false (3); let
 * Chrome on iOS through the provider check (1); drop step 1's app hint (2); drop the
 * PasskeyLogin branch (1); stop carrying the manager into the probe's refusal (1).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// --- the REAL passkey-account module with a scripted authenticator (as passkey-prf-at-create.test.ts)
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

const GPM_AAGUID = "ea9b8d664d011d213ce4b6b48cb575d4";
/** Authenticator data carrying an AAGUID: rpIdHash 32 | flags (AT set) | signCount 4 | aaguid 16. */
function authDataWith(aaguidHex: string): ArrayBuffer {
  const d = new Uint8Array(53);
  d[32] = 0x45;
  for (let i = 0; i < 16; i++) d[37 + i] = parseInt(aaguidHex.slice(i * 2, i * 2 + 2), 16);
  return d.buffer;
}

let createExt: Record<string, unknown> = {};
let aaguid: string | null = GPM_AAGUID;
const calls = { create: 0, get: 0 };

Object.defineProperty(globalThis, "navigator", {
  value: {
    credentials: {
      create: async () => {
        calls.create++;
        return {
          rawId: new Uint8Array(16).fill(1).buffer,
          authenticatorAttachment: "platform",
          response: { getAuthenticatorData: () => (aaguid ? authDataWith(aaguid) : new ArrayBuffer(37)) },
          getClientExtensionResults: () => createExt,
        };
      },
      get: async () => {
        calls.get++;
        return {
          rawId: new Uint8Array(16).fill(1).buffer,
          authenticatorAttachment: "platform",
          response: { userHandle: null },
          getClientExtensionResults: () => ({}),
        };
      },
    },
  },
  configurable: true,
  writable: true,
});
(globalThis as { window?: unknown }).window = { location: { hostname: "localhost" } };
installFakeIndexedDB();

const { createPasskeyAccount, PasskeyPrfUnsupportedError } = await import("../src/lib/auth/passkey-account.ts");
const { passkeyReadinessFrom } = await import("../src/lib/auth/passkey-readiness.ts");
const copy = await import("../src/lib/auth/passkey-refusal-copy.ts");

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1";
const IPAD_AS_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";

// --- the creation

test("a manager that says it has no PRF is refused at once, named, with no second prompt", async () => {
  createExt = { prf: { enabled: false } };
  aaguid = GPM_AAGUID;
  calls.get = 0;
  const e = await createPasskeyAccount().then(
    () => assert.fail("must not create an account"),
    (err: unknown) => err,
  );
  assert.ok(e instanceof PasskeyPrfUnsupportedError);
  assert.equal(calls.get, 0, "no follow-up assertion: it could only fail, as 'sign in to finish'");
  assert.equal(e.provider, "google-password-manager");
  assert.match(e.message, /^Google Password Manager saved the passkey/);
  assert.match(e.message, /Delete the "WoCo Account" passkey from Google Password Manager/);
  assert.doesNotMatch(e.message, /PRF|extension/);
});

test("an unidentified manager is not named, and the probe still runs when creation said nothing", async () => {
  createExt = {};
  aaguid = null;
  calls.get = 0;
  const e = await createPasskeyAccount().then(() => assert.fail("no PRF anywhere"), (err: unknown) => err);
  assert.ok(e instanceof PasskeyPrfUnsupportedError);
  assert.equal(calls.get, 1, "Samsung Pass rule kept: silence at creation is probed once");
  assert.equal(e.provider, "unknown");
  assert.match(e.message, /^This password manager saved the passkey/);
});

test("a sign-in's refusal no longer recommends the manager that may have failed", () => {
  const m = new PasskeyPrfUnsupportedError().message;
  assert.match(m, /Apple Passwords on an iPhone, iPad or Mac, or Google Password Manager on Android or in Chrome/);
  assert.equal(new PasskeyPrfUnsupportedError().provider, undefined);
});

// --- the pre-check

test("iPhone Safari not configured for passkeys: told before Create", () => {
  assert.deepEqual(passkeyReadinessFrom({ userAgent: IPHONE_SAFARI, maxTouchPoints: 5, uvpaa: false, prf: undefined }), {
    kind: "no-provider",
    device: "iPhone",
  });
  assert.deepEqual(passkeyReadinessFrom({ userAgent: IPAD_AS_MAC, maxTouchPoints: 5, uvpaa: false, prf: undefined }), {
    kind: "no-provider",
    device: "iPad",
  });
});

test("unknown is never a refusal: no answer, a configured device, or a missing prf key", () => {
  for (const s of [
    { userAgent: IPHONE_SAFARI, maxTouchPoints: 5, uvpaa: null, prf: undefined },
    { userAgent: IPHONE_SAFARI, maxTouchPoints: 5, uvpaa: true, prf: undefined },
    { userAgent: ANDROID, maxTouchPoints: 5, uvpaa: false, prf: undefined },
    { userAgent: IPAD_AS_MAC, maxTouchPoints: 0, uvpaa: false, prf: undefined },
  ]) {
    assert.deepEqual(passkeyReadinessFrom(s), { kind: "ok" }, JSON.stringify(s));
  }
});

test("other iOS browsers can bring their own manager, so their false says nothing", () => {
  assert.deepEqual(passkeyReadinessFrom({ userAgent: IPHONE_CHROME, maxTouchPoints: 5, uvpaa: false, prf: undefined }), { kind: "ok" });
});

test("an explicit extension:prf false is believed on any browser", () => {
  assert.deepEqual(passkeyReadinessFrom({ userAgent: ANDROID, maxTouchPoints: 5, uvpaa: true, prf: false }), { kind: "no-prf" });
});

// --- the words

test("the setup steps come in order and name the deleted-app case", () => {
  const s = copy.passkeySetupSteps("iPhone");
  const at = (x: string) => s.indexOf(x);
  assert.ok(at("1) Settings › General › AutoFill & Passwords") === 0);
  assert.ok(at("2) Settings › your name › iCloud › Passwords: turn on Sync this iPhone") > 0);
  assert.ok(at("3) Settings › Face ID & Passcode") > at("2)"));
  assert.ok(at("4) A work or school profile, or Screen Time") > at("3)"));
  assert.match(s, /install Apple's Passwords app from the App Store/);
  for (const t of [s, copy.passkeyNotReadyNotice("iPad", false), copy.passkeyNoSecretAdvice("iPhone", "Google Password Manager", false)]) {
    assert.ok(!t.includes("—"), "owner copy: spaced hyphen, never an em dash");
  }
});

test("every iPhone message carries the steps; organisers are never pointed at email", () => {
  for (const invite of [false, true]) {
    const msgs = [
      copy.passkeyCreateRefusedAdvice("iPhone", invite),
      copy.passkeyNotReadyNotice("iPhone", invite),
      copy.passkeyNoSecretAdvice("iPhone", null, invite),
    ];
    for (const m of msgs) {
      assert.match(m, /install Apple's Passwords app/);
      assert.equal(/email/i.test(m), !invite, m);
    }
    assert.equal(/email/i.test(copy.passkeyNoPrfNotice(invite)), !invite);
  }
  assert.match(copy.passkeyNoSecretAdvice("iPhone", "Google Password Manager", false), /Delete the "WoCo Account" passkey from Google Password Manager/);
});

// --- wiring

test("PasskeyLogin: the named-manager advice is for a creation on an iPhone/iPad, before the generic line", () => {
  const src = read("../src/lib/components/auth/PasskeyLogin.svelte");
  const branch = src.indexOf('} else if (mode === "create" && res.error instanceof PasskeyPrfUnsupportedError && (apple = appleDevice())) {');
  const generic = src.indexOf("Passkey authentication failed. Try again or use another method.");
  assert.ok(branch > 0 && generic > branch);
  assert.ok(src.includes("passkeyNoSecretAdvice(apple, name, organiser)"));
  assert.ok(src.includes("<PasskeyReadyNotice invite={organiser} />"));
});

test("the organiser onboarding screen says what the phone needs, before the passkey step", () => {
  const src = read("../src/lib/creator/gate/OrganiserNeedsPasskey.svelte");
  assert.ok(src.indexOf("<PasskeyReadyNotice invite />") > src.indexOf("<h1>Organising uses a passkey account</h1>"));
  const notice = read("../src/lib/components/auth/PasskeyReadyNotice.svelte");
  assert.ok(!/disabled|hidden/.test(notice.split("<style>")[0]!.replace(/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\//g, "")), "advice only - never blocks");
});
