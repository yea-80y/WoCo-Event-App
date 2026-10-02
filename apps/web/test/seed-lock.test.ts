/**
 * #746 fix 1: a passkey account's seed is locked under its passkey on the device,
 * and opens once per app open.
 *
 * Two layers, tested two ways. The storage layer (identity-seed.ts) and the policy
 * run for real against an in-memory IndexedDB. The auth store is a runes module
 * this suite cannot load, so its rules - who may read the seed without asking, what
 * sign-out keeps, when a page relocks - are pinned at the source, as
 * identity-seed.test.ts pins the eager-establish order.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// --- minimal in-memory IndexedDB, same shim as identity-seed.test.ts, plus one
// hook: puts under `corruptPrefix` store bytes that will not decrypt, so the
// "locked copy written but does not open" branch can be reached.
const data = new Map<string, unknown>();
let corruptPrefix: string | null = null;
function installFakeIndexedDB() {
  const stores = new Set<string>();
  const fire = (req: Record<string, unknown>, result?: unknown) =>
    queueMicrotask(() => {
      req.result = result;
      (req.onsuccess as ((e: unknown) => void) | undefined)?.({ target: req });
    });
  const objectStore = () => ({
    get: (k: string) => { const req: Record<string, unknown> = {}; fire(req, data.has(k) ? data.get(k) : undefined); return req; },
    put: (v: unknown, k: string) => {
      const req: Record<string, unknown> = {};
      data.set(k, corruptPrefix && k.startsWith(corruptPrefix) ? { iv: "00".repeat(12), ct: "00".repeat(32) } : v);
      fire(req);
      return req;
    },
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
installFakeIndexedDB();

const seedMod = await import("../src/lib/auth/identity-seed.ts");
const policyMod = await import("../src/lib/auth/seed-unlock-policy.ts");
const { StorageKeys } = await import("@woco/shared");

const ADDR = "0x1111111111111111111111111111111111111111";
const PARENT = "0x00000000000000000000000000000000000000aa";
const OTHER_PARENT = "0x00000000000000000000000000000000000000bb";
const PRF = "0x" + "cd".repeat(32);
const OTHER_PRF = "0x" + "ce".repeat(32);
const SEED = "0x" + "5e".repeat(32);
const LOCKED_SLOT = `${StorageKeys.IDENTITY_SEED_LOCKED}:${ADDR}`;
const DEVICE_SLOT = `${StorageKeys.IDENTITY_SEED}:${ADDR}`;
const PER_APP_OPEN = { mode: "per-app-open", relockAfterHiddenMs: 15 * 60_000 } as const;

async function fresh(): Promise<void> {
  data.clear();
  corruptPrefix = null;
}

// ── The lock ────────────────────────────────────────────────────────────────

test("a locked seed opens with its passkey for its account, and only then", async () => {
  await fresh();
  await seedMod.storeLockedSeed(ADDR, PARENT, SEED, PRF);
  assert.equal(await seedMod.restoreIdentitySeed(ADDR), null, "nothing opens it without the passkey");
  assert.equal(await seedMod.openLockedSeed(ADDR, PARENT, PRF), SEED);
});

test("a copy locked for another account fails its tag and is deleted (#233 belt)", async () => {
  await fresh();
  await seedMod.storeLockedSeed(ADDR, OTHER_PARENT, SEED, PRF);
  assert.equal(await seedMod.openLockedSeed(ADDR, PARENT, PRF), null);
  assert.equal(data.has(LOCKED_SLOT), false);
});

test("a copy locked under another passkey does not open and is deleted", async () => {
  await fresh();
  await seedMod.storeLockedSeed(ADDR, PARENT, SEED, OTHER_PRF);
  assert.equal(await seedMod.openLockedSeed(ADDR, PARENT, PRF), null);
  assert.equal(data.has(LOCKED_SLOT), false);
});

test("a legacy device-key copy is locked, proved to open, then deleted", async () => {
  await fresh();
  await seedMod.storeIdentitySeed(ADDR, SEED);
  assert.equal(await seedMod.openLockedSeed(ADDR, PARENT, PRF), SEED);
  assert.equal(data.has(DEVICE_SLOT), false, "the silently readable copy must go");
  assert.equal(await seedMod.openLockedSeed(ADDR, PARENT, PRF), SEED, "and the locked one must open");
});

test("a locked copy that does not open back keeps the legacy copy", async () => {
  // The order that matters: a recovered account cannot re-derive its seed, and
  // may not be able to re-open its envelope, so the old copy goes only after the
  // new one is proved.
  await fresh();
  await seedMod.storeIdentitySeed(ADDR, SEED);
  corruptPrefix = StorageKeys.IDENTITY_SEED_LOCKED;
  assert.equal(await seedMod.openLockedSeed(ADDR, PARENT, PRF), SEED);
  assert.equal(data.has(DEVICE_SLOT), true);
  corruptPrefix = null;
  assert.equal(await seedMod.openLockedSeed(ADDR, PARENT, PRF), SEED, "the next unlock finishes the move");
  assert.equal(data.has(DEVICE_SLOT), false);
});

test("establishing a passkey seed writes the locked copy only", async () => {
  await fresh();
  const { seed } = await seedMod.establishPasskeyIdentitySeed(ADDR, PARENT, PRF);
  assert.equal(data.has(DEVICE_SLOT), false);
  assert.equal(await seedMod.openLockedSeed(ADDR, PARENT, PRF), seed);
});

test("sign-out keeps the locked copy; only a heal deletes it", async () => {
  await fresh();
  await seedMod.storeLockedSeed(ADDR, PARENT, SEED, PRF);
  await seedMod.writePublicKeys(ADDR, { parent: PARENT, feedSignerAddress: ADDR });
  await seedMod.clearIdentitySeed(ADDR);
  assert.equal(await seedMod.hasLockedSeed(ADDR), true);
  assert.equal(await seedMod.readPublicFeedSignerAddress(ADDR, PARENT), null, "the public record goes with the session");
  await seedMod.clearLockedSeed(ADDR);
  assert.equal(await seedMod.hasLockedSeed(ADDR), false);
});

test("the public record answers only for the account that wrote it", async () => {
  await fresh();
  await seedMod.writePublicKeys(ADDR, { parent: PARENT, feedSignerAddress: "0xABCDEF0000000000000000000000000000000001" });
  assert.equal(await seedMod.readPublicFeedSignerAddress(ADDR, OTHER_PARENT), null);
  assert.equal(
    await seedMod.readPublicFeedSignerAddress(ADDR, PARENT.toUpperCase().replace("0X", "0x")),
    "0xabcdef0000000000000000000000000000000001",
  );
});

// ── The policy ──────────────────────────────────────────────────────────────

test("per-app-open never opens a device copy, even one that is there", async () => {
  await fresh();
  await seedMod.storeIdentitySeed(ADDR, SEED);
  assert.equal(await seedMod.restoreSilentSeed(ADDR, PER_APP_OPEN), null);
  assert.equal(data.has(DEVICE_SLOT), true, "a read never deletes - it may be a legacy copy awaiting its first unlock");
});

test("always opens the device copy silently, as before fix 1", async () => {
  await fresh();
  await seedMod.storeIdentitySeed(ADDR, SEED);
  assert.equal(await seedMod.restoreSilentSeed(ADDR, { mode: "always" }), SEED);
});

test("device-window opens only an unexpired copy it wrote itself", async () => {
  await fresh();
  const window = { mode: "device-window", ms: 60_000 } as const;
  await seedMod.storeIdentitySeed(ADDR, SEED);
  assert.equal(await seedMod.restoreSilentSeed(ADDR, window), null, "a copy with no expiry is not a window's");
  await seedMod.applySeedPolicy(ADDR, SEED, window, 1_000);
  assert.equal(await seedMod.restoreSilentSeed(ADDR, window, 1_000 + 59_000), SEED);
  assert.equal(await seedMod.restoreSilentSeed(ADDR, window, 1_000 + 60_000), null);
});

test("per-app-open drops a device copy only once the locked copy is there", async () => {
  await fresh();
  await seedMod.storeIdentitySeed(ADDR, SEED);
  await seedMod.applySeedPolicy(ADDR, SEED, PER_APP_OPEN);
  assert.equal(data.has(DEVICE_SLOT), true, "no locked copy yet: the device copy is the only one");
  await seedMod.storeLockedSeed(ADDR, PARENT, SEED, PRF);
  await seedMod.sweepSilentCopy(ADDR, PER_APP_OPEN);
  assert.equal(data.has(DEVICE_SLOT), false);
});

test("the shipped policy is per-app-open with a relock", () => {
  assert.equal(policyMod.SEED_UNLOCK_POLICY.mode, "per-app-open");
  assert.equal(policyMod.keepsSilentCopy(policyMod.SEED_UNLOCK_POLICY), false);
  const relock = (policyMod.SEED_UNLOCK_POLICY as { relockAfterHiddenMs?: number }).relockAfterHiddenMs;
  assert.ok(relock !== undefined && relock > 0);
  assert.equal(policyMod.shouldRelock(policyMod.SEED_UNLOCK_POLICY, relock - 1), false);
  assert.equal(policyMod.shouldRelock(policyMod.SEED_UNLOCK_POLICY, relock), true);
  assert.equal(policyMod.shouldRelock({ mode: "always" }, Number.MAX_SAFE_INTEGER), false);
  assert.equal(policyMod.silentCopyExpiry({ mode: "device-window", ms: 10 }, 5), 15);
  assert.equal(policyMod.silentCopyExpiry({ mode: "always" }, 5), null);
});

// ── The store's rules, pinned at the source ─────────────────────────────────

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const STORE = read("../src/lib/auth/auth-store.svelte.ts");
/** A function's body, to its own closing brace at column 0. */
function body(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist - a rename would make this pass vacuously`);
  return src.slice(start, src.indexOf("\n}\n", start));
}

test("store: a passkey account's seed is read without asking only from memory", () => {
  assert.match(body(STORE, "async function _seedIfPresent"), /if \(_kind === "passkey"\) return _unlockedSeed\(\);/);
  for (const fn of ["async function _getContentFeedSignerIfPresent", "async function _manifestSigner"]) {
    const b = body(STORE, fn);
    assert.match(b, /_seedIfPresent\(\)/, `${fn} reads through _seedIfPresent`);
    assert.doesNotMatch(b, /_ensureIdentitySeed|_ensurePasskeyKey|restoreIdentitySeed/, `${fn} must never unlock or read the device copy`);
  }
});

test("store: a reload never opens a passkey seed silently, except by policy", () => {
  const b = body(STORE, "async function _restoreCachedAuth");
  const passkey = b.slice(b.indexOf('if (_kind === "passkey") {'));
  const branch = passkey.slice(0, passkey.indexOf("\n    return;\n  }\n"));
  assert.match(branch, /restoreSilentSeed\(seedAddr, SEED_UNLOCK_POLICY\)/);
  assert.doesNotMatch(branch, /restoreIdentitySeed\(/);
});

test("store: sign-out keeps the locked copy and drops the unlocked one", () => {
  const b = body(STORE, "async function clearAllAuth");
  assert.doesNotMatch(b, /clearLockedSeed/);
  assert.match(b, /_unlocked = null;/);
});

test("store: a page hidden past the policy's limit relocks everything a ceremony gave", () => {
  assert.match(body(STORE, "function _onVisibilityChange"), /shouldRelock\(SEED_UNLOCK_POLICY, Date\.now\(\) - since\)\) _relockPasskey\(\)/);
  const relock = body(STORE, "function _relockPasskey");
  for (const field of ["_unlocked", "_passkeyPrivateKey", "_passkeyPrfSecret", "_kernel"]) {
    assert.match(relock, new RegExp(`${field} = null;`), `relock must drop ${field}`);
  }
  assert.match(body(STORE, "async function init"), /addEventListener\("visibilitychange", _onVisibilityChange\)/);
});

test("store: a cancelled passkey sheet does not open a second one", () => {
  const b = body(STORE, "async function _ensurePasskeyKey");
  assert.match(b, /restorePasskeyAccount\(\{ retryDiscoverable: _offerPickerNext \}\)/);
  assert.match(b, /catch \(e\) \{\s*_offerPickerNext = true;/);
});

test("store: any ceremony unlocks the seed, so one biometric covers session and keys", () => {
  assert.match(body(STORE, "async function _ensurePasskeyKey"), /void _establishPasskeySeedEagerly\(\);$/);
});

test("passive likes, follows and subjects read by ADDRESS - never a prompt on page open", () => {
  const social = read("../src/lib/social/social.ts");
  for (const fn of ["export async function readMyStatement", "export async function readMySubjects", "export async function readMyFollowsIfReady"]) {
    const b = body(social, fn);
    assert.match(b, /auth\.getContentFeedSignerAddress\(\)/, fn);
    assert.doesNotMatch(b, /getContentFeedSigner\(\)|getContentFeedSignerIfPresent/, fn);
  }
  const feedLog = read("../src/lib/manifest/feed-log.ts");
  assert.doesNotMatch(feedLog, /auth\.getContentFeedSigner\(\)/, "the manifest hooks must stay prompt-free");
});

test("Dashboard: attendee details ask for the passkey only from a tap", () => {
  const dash = read("../src/lib/creator/dashboard/Dashboard.svelte");
  const decrypt = body(dash.replace(/\n  }\n/g, "\n}\n"), "async function decryptCurrent(prompt = false)");
  assert.match(decrypt, /if \(!identitySeed && prompt\) \{\s*if \(!\(await auth\.ensureAccountSetup\(\{ identity: true \}\)\)\)/);
  // Every call without `true` is a page-open path; the one with it is a button.
  assert.deepEqual(dash.match(/decryptCurrent\(true\)/g)?.length, 1);
  assert.match(dash, /onEnsureDecrypted=\{\(\) => decryptCurrent\(true\)\}/);
  assert.doesNotMatch(dash, /restoreIdentitySeed|ensureIdentitySeed/);
});

// ── Sign-off fixes (Fable, #746 fix 1) ─────────────────────────────────────

test("store: the unlocked seed is read only for the account AND credential it was unlocked for", () => {
  const b = body(STORE, "function _unlockedSeed");
  assert.match(b, /_unlocked\.seedAddress !== seedAddr\.toLowerCase\(\)/);
  assert.match(b, /_unlocked\.parent === _parent\.toLowerCase\(\)/);
});

test("store: a relock waits for a ceremony in flight, and invalidates work that resumes after it", () => {
  const relock = body(STORE, "function _relockPasskey");
  assert.match(relock, /if \(_kind !== "passkey" \|\| _passkeyKeyInFlight \|\| _seedInFlight\) return;/);
  assert.match(relock, /_lockGen\+\+;/);
  const kernel = body(STORE, "async function _ensureKernel()");
  const captured = kernel.indexOf("const gen = _lockGen;");
  const checked = kernel.indexOf("if (gen !== _lockGen) throw");
  const assigned = kernel.indexOf("_kernel = kernel;");
  assert.ok(captured > 0 && checked > captured && assigned > checked, "capture -> build -> check -> assign");
  assert.match(body(STORE, "async function clearAllAuth"), /_lockGen\+\+;/);
});

test("store: an unlock that finishes after an account switch is not adopted", () => {
  assert.match(body(STORE, "async function _unlockPasskeySeed"), /if \(_kind !== "passkey" \|\| _parent !== parent\) return false;/);
});

test("store: a silent restore does not re-stamp a device-window copy", () => {
  assert.match(body(STORE, "async function _restoreCachedAuth"), /_setUnlockedSeed\(seedAddr, _parent, silent, \{ fromSilentCopy: true \}\)/);
  const set = body(STORE, "function _setUnlockedSeed");
  const early = set.indexOf("if (opts.fromSilentCopy) return;");
  assert.ok(early > 0 && early < set.indexOf("applySeedPolicy("), "return before the policy write");
});

test("store: a recovered account with no copy here is told so, not that it declined", () => {
  const unlock = body(STORE, "async function _unlockPasskeySeed");
  assert.match(unlock, /if \(await _recoveryKernelFor\(seedAddr\)\) \{[\s\S]*?_seedUnavailable = "recovered-no-copy";\s*return false;/);
  assert.match(body(STORE, "function _setUnlockedSeed"), /_seedUnavailable = null;/);
  assert.match(body(STORE, "async function clearAllAuth"), /_seedUnavailable = null;/);
  assert.match(STORE, /get seedUnavailable\(\) \{ return _seedUnavailable; \}/);
});

test("store: sign-out keeps a recovered account's only copy until a sign-in has locked it", () => {
  const b = body(STORE, "async function clearAllAuth");
  const keep = b.slice(b.indexOf("const keepUnlockedLegacy ="), b.indexOf("if (keepUnlockedLegacy)"));
  for (const term of ['_kind === "passkey"', "!_passkeyPrfSecret", "_recoveryKernelFor(seedAddr)", "!(await hasLockedSeed(seedAddr)"]) {
    assert.ok(keep.includes(term), `the exception must require ${term}`);
  }
  assert.match(b, /if \(keepUnlockedLegacy\) \{[\s\S]*?clearPublicKeys[\s\S]*?\} else \{\s*await step\("identity-seed", \(\) => clearIdentitySeed\(seedAddr\)\);/);
});

test("Audience: a failed load cannot loop, the list opens once, and only a save asks", () => {
  const aud = read("../src/lib/creator/audience/AudienceScreen.svelte");
  assert.match(aud, /async function load\(\): Promise<void> \{\s*loading = true;\s*loadError = null;\s*listLocked = false;/);
  assert.deepEqual(aud.match(/getKeys\(true\)/g)?.length, 1);
  assert.match(aud, /async function commitList[\s\S]*?getKeys\(true\)/);
  assert.match(aud, /<UnlockPanel subject="Contact details" action="Show contacts" \/>/, "the effect loads; the panel must not load too");
});

test("Dashboard: the unlock decrypts once, and a relock hides the details again", () => {
  const dash = read("../src/lib/creator/dashboard/Dashboard.svelte");
  assert.match(dash, /if \(auth\.hasIdentitySeed && ordersLocked && !decrypting\) void decryptCurrent\(\);/);
  assert.match(dash, /<UnlockPanel subject="Attendee details" action="Show attendees" \/>/);
  assert.match(dash, /if \(auth\.kind === "passkey" && !auth\.hasIdentitySeed && decryptedOrders\.size > 0\) \{\s*decryptedOrders = new Map\(\);\s*ordersLocked = true;/);
});

test("Cancel: the passkey is asked when the form opens, never between the final press and the refunds", () => {
  const cancel = read("../src/lib/creator/events/CancelEventPanel.svelte");
  assert.match(body(cancel.replace(/\n  }\n/g, "\n}\n"), "async function openForm()"), /auth\.ensureAccountSetup\(\{ identity: true \}\)/);
  assert.doesNotMatch(body(cancel.replace(/\n  }\n/g, "\n}\n"), "async function confirmCancel()"), /ensureAccountSetup|ensureIdentitySeed|getContentFeedSigner\(\)/);
});

test("copy: the new lines never name the mechanism and use the spaced hyphen", () => {
  const panel = read("../src/lib/components/auth/UnlockPanel.svelte");
  const markup = panel.slice(panel.indexOf("</script>"));
  const messages = [
    markup,
    STORE.slice(STORE.indexOf("const SEED_UNAVAILABLE_MESSAGE"), STORE.indexOf("/** The unlocked passkey seed")),
  ];
  for (const text of messages) {
    assert.doesNotMatch(text, /fingerprint|biometric|\bPRF\b|quantum|—/i);
  }
});

test("a like or follow unlocks the keys first, while the tap is still the gesture", () => {
  const social = read("../src/lib/api/social.ts");
  const toggle = body(social, "export async function toggleSocial");
  const unlock = toggle.indexOf("await auth.ensureAccountSetup({ identity: true })");
  const gateRead = toggle.indexOf("gate.refresh()");
  assert.ok(unlock > 0 && gateRead > unlock, "unlock before the gate's network read");
});
