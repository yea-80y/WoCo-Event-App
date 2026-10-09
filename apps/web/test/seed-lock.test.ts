/**
 * #746: a passkey account's seed is locked under its passkey on the device. An
 * unlock opens it for a window (two hours as shipped) that survives reloads and
 * then closes; everyday posts sign with a cached feed signer and never ask.
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
const WINDOW_SLOT = `${StorageKeys.IDENTITY_SEED_WINDOW}:${ADDR}`;
const CACHE_SLOT = `${StorageKeys.FEED_SIGNER_CACHE}:${ADDR}`;
const PER_APP_OPEN = { mode: "per-app-open" } as const;
const WINDOW = { mode: "device-window", ms: 60_000 } as const;
const SIGNER = { privKey: "0x" + "ab".repeat(32), address: "0x2222222222222222222222222222222222222222" };

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

// ── The window and the cached feed signer ──────────────────────────────────

test("the window copy opens for its account while the window is open", async () => {
  await fresh();
  await seedMod.writeUnlockWindow(ADDR, PARENT, SEED, 61_000);
  assert.deepEqual(await seedMod.restoreSilentSeed(ADDR, PARENT, WINDOW, 1_000 + 59_000), { seed: SEED, expiresAt: 61_000 });
});

test("another account's window copy does not open, and goes (#233)", async () => {
  await fresh();
  await seedMod.writeUnlockWindow(ADDR, OTHER_PARENT, SEED, 61_000);
  assert.equal(await seedMod.restoreSilentSeed(ADDR, PARENT, WINDOW, 1_000), null);
  assert.equal(data.has(WINDOW_SLOT), false);
});

test("an expired window copy is deleted, not just ignored", async () => {
  await fresh();
  await seedMod.writeUnlockWindow(ADDR, PARENT, SEED, 61_000);
  assert.equal(await seedMod.restoreSilentSeed(ADDR, PARENT, WINDOW, 61_000), null);
  assert.equal(data.has(WINDOW_SLOT), false);
});

test("a window copy dated further out than the policy allows is deleted", async () => {
  // A shortened window, or a clock set back: the copy must not outlive the rule.
  await fresh();
  await seedMod.writeUnlockWindow(ADDR, PARENT, SEED, 1_000 + 60_001);
  assert.equal(await seedMod.restoreSilentSeed(ADDR, PARENT, WINDOW, 1_000), null);
  assert.equal(data.has(WINDOW_SLOT), false);
});

test("per-app-open keeps no window copy, and drops one it finds", async () => {
  await fresh();
  await seedMod.writeUnlockWindow(ADDR, PARENT, SEED, 61_000);
  assert.equal(await seedMod.restoreSilentSeed(ADDR, PARENT, PER_APP_OPEN, 1_000), null);
  assert.equal(data.has(WINDOW_SLOT), false);
  await seedMod.writeUnlockWindow(ADDR, PARENT, SEED, null);
  assert.equal(data.has(WINDOW_SLOT), false);
});

test("a legacy device-key copy never opens silently, and goes only once the lock is here", async () => {
  await fresh();
  await seedMod.storeIdentitySeed(ADDR, SEED);
  assert.equal(await seedMod.restoreSilentSeed(ADDR, PARENT, WINDOW, 1_000), null);
  await seedMod.writeUnlockWindow(ADDR, PARENT, SEED, 61_000);
  assert.equal(data.has(DEVICE_SLOT), true, "no locked copy yet: the device copy is the only one");
  await seedMod.storeLockedSeed(ADDR, PARENT, SEED, PRF);
  await seedMod.writeUnlockWindow(ADDR, PARENT, SEED, 61_000);
  assert.equal(data.has(DEVICE_SLOT), false);
});

test("a write a sign-out overtook leaves nothing behind", async () => {
  await fresh();
  await seedMod.writeUnlockWindow(ADDR, PARENT, SEED, 61_000, () => false);
  await seedMod.storeFeedSignerCache(ADDR, PARENT, SIGNER, () => false);
  assert.equal(data.has(WINDOW_SLOT), false);
  assert.equal(data.has(CACHE_SLOT), false);
});

test("the cached feed signer opens only for its account, and is left for that account", async () => {
  await fresh();
  await seedMod.storeFeedSignerCache(ADDR, PARENT, SIGNER);
  assert.deepEqual(await seedMod.readFeedSignerCache(ADDR, PARENT), SIGNER);
  assert.equal(await seedMod.readFeedSignerCache(ADDR, OTHER_PARENT), null);
  assert.equal(data.has(CACHE_SLOT), true);
});

test("sign-out drops the window copy and the cached feed signer, keeps the locked copy", async () => {
  await fresh();
  await seedMod.storeLockedSeed(ADDR, PARENT, SEED, PRF);
  await seedMod.writeUnlockWindow(ADDR, PARENT, SEED, 61_000);
  await seedMod.storeFeedSignerCache(ADDR, PARENT, SIGNER);
  await seedMod.clearIdentitySeed(ADDR);
  assert.equal(data.has(WINDOW_SLOT), false);
  assert.equal(data.has(CACHE_SLOT), false);
  assert.equal(await seedMod.hasLockedSeed(ADDR), true);
  await seedMod.writeUnlockWindow(ADDR, PARENT, SEED, 61_000);
  await seedMod.storeFeedSignerCache(ADDR, PARENT, SIGNER);
  await seedMod.clearDeviceUnlock(ADDR);
  assert.equal(data.has(WINDOW_SLOT), false);
  assert.equal(data.has(CACHE_SLOT), false);
});

test("the shipped policy is a two-hour window, and the copy says so", () => {
  assert.deepEqual(policyMod.SEED_UNLOCK_POLICY, { mode: "device-window", ms: 2 * 60 * 60_000 });
  assert.equal(policyMod.unlockExpiry({ mode: "device-window", ms: 10 }, 5), 15);
  assert.equal(policyMod.unlockExpiry(PER_APP_OPEN, 5), null);
  assert.equal(policyMod.unlockPromise(policyMod.SEED_UNLOCK_POLICY), "WoCo won't ask again for about two hours.");
  assert.equal(policyMod.unlockPromise({ mode: "device-window", ms: 60 * 60_000 }), "WoCo won't ask again for about an hour.");
  assert.equal(policyMod.unlockPromise({ mode: "device-window", ms: 30 * 60_000 }), "WoCo won't ask again for about 30 minutes.");
  assert.equal(policyMod.unlockPromise({ mode: "device-window", ms: 24 * 60 * 60_000 }), "WoCo won't ask again for about 24 hours.");
  assert.equal(policyMod.unlockPromise(PER_APP_OPEN), "WoCo asks once each time you open it.");
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
  const ready = body(STORE, "async function _feedSignerIfPresent");
  assert.match(ready, /_seedIfPresent\(\)/);
  assert.match(ready, /readFeedSignerCache\(seedAddr, parent\)/);
  assert.match(ready, /_parent\?\.toLowerCase\(\) !== parent\) return null;/, "re-check the account after the read");
  for (const fn of ["async function _feedSignerIfPresent", "async function _getContentFeedSignerIfPresent", "async function _manifestSigner"]) {
    const b = body(STORE, fn);
    if (fn !== "async function _feedSignerIfPresent") assert.match(b, /_feedSignerIfPresent\(\)/, `${fn} reads through _feedSignerIfPresent`);
    assert.doesNotMatch(b, /_ensureIdentitySeed|_ensurePasskeyKey|restoreIdentitySeed/, `${fn} must never unlock or read the device copy`);
  }
});

test("store: an everyday post signs with what is here before anything asks", () => {
  const inner = body(STORE, "async function _getContentFeedSignerInner");
  const ready = inner.indexOf("await _feedSignerIfPresent()");
  assert.ok(ready > 0 && ready < inner.indexOf("_ensureIdentitySeed("), "the cached signer is read before any unlock");
  assert.match(body(STORE, "async function ensureContentSigner"), /ensureAccountSetup\(\{ identity: !\(await _feedSignerIfPresent\(\)\) \}\)/);
});

test("store: a reload never opens a passkey seed silently, except by policy", () => {
  const b = body(STORE, "async function _restoreCachedAuth");
  const passkey = b.slice(b.indexOf('if (_kind === "passkey") {'));
  const branch = passkey.slice(0, passkey.indexOf("\n    return;\n  }\n"));
  assert.match(branch, /restoreSilentSeed\(seedAddr, parent, SEED_UNLOCK_POLICY\)/);
  assert.doesNotMatch(branch, /restoreIdentitySeed\(/);
});

test("store: sign-out keeps the locked copy and drops the unlocked one", () => {
  const b = body(STORE, "async function clearAllAuth");
  assert.doesNotMatch(b, /clearLockedSeed/);
  assert.match(b, /_unlocked = null;/);
});

test("store: the window closes on time and takes everything a ceremony gave", () => {
  assert.match(body(STORE, "function _unlockedSeed"), /if \(_unlocked\.expiresAt !== null && Date\.now\(\) >= _unlocked\.expiresAt\) return null;/);
  assert.match(body(STORE, "function _expireUnlockIfDue"), /Date\.now\(\) >= _unlocked\.expiresAt\) _relockPasskey\(\);/);
  assert.match(body(STORE, "function _onVisibilityChange"), /_expireUnlockIfDue\(\)/);
  assert.match(body(STORE, "function _scheduleUnlockExpiry"), /setTimeout\([\s\S]*?_expireUnlockIfDue\(\);/);
  assert.match(body(STORE, "function _setUnlockedSeed"), /_scheduleUnlockExpiry\(expiresAt\);/);
  // The PRF output in memory would reopen the locked copy with no new confirm, so
  // each of these closes an expired window BEFORE it looks at what is in memory.
  for (const [fn, after] of [
    ["async function _ensurePasskeyKey", "if (_passkeyPrivateKey && _passkeyPrfSecret && _seedAddress) return;"],
    ["async function _ensureIdentitySeed", "if (_identitySeedPresent) return true;"],
    ["async function ensureAccountSetup", "const plan = planAccountSetup("],
    ["async function ensureOrganiserUnlock", "if (_unlockedSeed()) return;"],
  ] as const) {
    const b = body(STORE, fn);
    const expire = b.indexOf("_expireUnlockIfDue();");
    assert.ok(expire > 0 && expire < b.indexOf(after), `${fn} closes an expired window first`);
  }
  const relock = body(STORE, "function _relockPasskey");
  for (const field of ["_unlocked", "_passkeyPrivateKey", "_passkeyPrfSecret", "_kernel"]) {
    assert.match(relock, new RegExp(`${field} = null;`), `relock must drop ${field}`);
  }
  assert.doesNotMatch(relock, /_feedSignerCache/, "the cached feed signer outlives a relock - everyday posts use it");
  assert.match(body(STORE, "async function init"), /addEventListener\("visibilitychange", _onVisibilityChange\)/);
});

test("store: the cached feed signer never outlives an account switch, a heal or a sign-out", () => {
  assert.match(body(STORE, "async function _clearStaleAuthForSwitch"), /_feedSignerCache = null;/);
  assert.match(body(STORE, "async function _clearSeedEverywhere"), /_feedSignerCache = null;[\s\S]*clearIdentitySeed\(eoa\)/);
  const out = body(STORE, "async function clearAllAuth");
  assert.match(out, /_feedSignerCache = null;/);
  assert.match(out, /_scheduleUnlockExpiry\(null\);/);
});

test("store: a sign-out wins over an unlock's writes still in flight", () => {
  const out = body(STORE, "async function clearAllAuth");
  const bump = out.indexOf("_lockGen++;");
  assert.ok(bump > 0 && bump < out.indexOf('await step("identity-keys"'), "bump before the first wipe");
  const set = body(STORE, "function _setUnlockedSeed");
  assert.match(set, /const gen = _lockGen;\s*const current = \(\) => gen === _lockGen;/);
  assert.match(set, /storeFeedSignerCache\(seedAddr, account, signer, current\)/);
  assert.match(set, /writeUnlockWindow\(seedAddr, account, seed, expiresAt, current\)/);
});

test("store: organiser actions confirm once per window; other kinds keep their own gate", () => {
  const b = body(STORE, "async function ensureOrganiserUnlock");
  assert.match(b, /if \(_kind !== "passkey"\) return;/);
  assert.match(b, /if \(!\(await ensureAccountSetup\(\{ identity: true \}\)\) \|\| !_unlockedSeed\(\)\) \{\s*throw new Error\(_organiserLockedMessage\(\)\);/);
  assert.match(STORE, /ensureContentSigner,\n[\s\S]*?ensureOrganiserUnlock,\n/);
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
  // The account's secrets (#186) - the seed and any later generations - not the bare seed.
  assert.match(decrypt, /if \(!secrets && prompt\) \{\s*if \(!\(await auth\.ensureAccountSetup\(\{ identity: true \}\)\)\)/);
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

test("store: a silent restore keeps the window it found and never re-stamps it", () => {
  assert.match(
    body(STORE, "async function _restoreCachedAuth"),
    /_setUnlockedSeed\(seedAddr, parent, silent\.seed, \{ restoredUntil: silent\.expiresAt \}\)/,
  );
  const set = body(STORE, "function _setUnlockedSeed");
  assert.match(set, /const expiresAt = opts\.restoredUntil \?\? unlockExpiry\(SEED_UNLOCK_POLICY\);/);
  // The restore branch returns before the window write (#186: it first starts loading
  // the account's later secrets from their window copy - never a fresh stamp).
  const early = set.indexOf("if (opts.restoredUntil !== undefined)");
  const write = set.indexOf("writeUnlockWindow(");
  assert.ok(early > 0 && early < write, "the restore branch comes before the window write");
  assert.match(set.slice(early, write), /return;/, "return before the window write");
  assert.match(set.slice(early, write), /_loadAccountChain\(seedAddr, account, gen, "window"\)/);
});

test("store: a restore never re-stamps, and another tab's open window counts before any ceremony", () => {
  assert.doesNotMatch(body(STORE, "async function _restoreCachedAuth"), /_establishPasskeySeedEagerly/);
  const unlock = body(STORE, "async function _unlockPasskeySeed");
  const adopt = unlock.indexOf("restoreSilentSeed(seedAddr, parent, SEED_UNLOCK_POLICY)");
  assert.ok(adopt > 0 && adopt < unlock.indexOf("await _ensurePasskeyKey()"), "adopt before asking");
  assert.match(unlock, /_setUnlockedSeed\(seedAddr, parent, open\.seed, \{ restoredUntil: open\.expiresAt \}\)/);
  assert.match(unlock, /if \(_seedAddress\?\.toLowerCase\(\) === seedAddr\.toLowerCase\(\)\) \{/, "never under the parent fallback");
});

test("a captured referral settles with the cached signer, not only after an unlock", () => {
  const app = read("../src/App.svelte");
  assert.match(app, /if \(!auth\.isAuthenticated \|\| !\(auth\.hasIdentitySeed \|\| auth\.kind === "passkey"\) \|\| refSettleInFlight\) return;/);
  assert.match(app, /getSigner: \(\) => auth\.getContentFeedSignerIfPresent\(\)/, "the settle still never prompts");
});

test("store: an account switch drops what opens the outgoing account without its passkey", () => {
  const sw = body(STORE, "async function _clearStaleAuthForSwitch");
  const prior = sw.indexOf("const priorSeedAddr = await getKV<string>(StorageKeys.SEED_ADDRESS);");
  assert.ok(prior > 0 && prior < sw.indexOf("await clearDeviceUnlock(priorSeedAddr)"));
  assert.doesNotMatch(sw, /clearLockedSeed/);
});

test("store: a real ceremony inside the window restarts it, for the same account only", () => {
  const eager = body(STORE, "async function _establishPasskeySeedEagerly");
  assert.match(eager, /held\.parent === _parent\?\.toLowerCase\(\) && held\.seedAddress === _seedAddress\?\.toLowerCase\(\)/);
  assert.match(eager, /_setUnlockedSeed\(held\.seedAddress, held\.parent, held\.seed\);/);
});

test("store: a recovered account with no copy here is told so, not that it declined", () => {
  const unlock = body(STORE, "async function _unlockPasskeySeed");
  assert.match(unlock, /if \(await _boundKernelAddress\(seedAddr\)\) \{[\s\S]*?_seedUnavailable = "recovered-no-copy";\s*return false;/);
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
  assert.match(b, /if \(keepUnlockedLegacy\) \{[\s\S]*?clearPublicKeys[\s\S]*?clearDeviceUnlock\(seedAddr!\)[\s\S]*?\} else \{\s*await step\("identity-seed", \(\) => clearIdentitySeed\(seedAddr\)\);/);
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

test("a like, a follow or a profile save asks only for the feed signer - silent once it is here", () => {
  const social = read("../src/lib/api/social.ts");
  const toggle = body(social, "export async function toggleSocial");
  const ready = toggle.indexOf("await auth.ensureContentSigner()");
  const gateRead = toggle.indexOf("gate.refresh()");
  assert.ok(ready > 0 && gateRead > ready, "before the gate's network read, while the tap is still the gesture");
  assert.doesNotMatch(toggle, /ensureAccountSetup\(\{ identity: true \}\)/);
  const profile = read("../src/lib/components/profile/ProfilePage.svelte");
  assert.match(profile, /const ok = await auth\.ensureContentSigner\(\);/);
  assert.doesNotMatch(profile, /ensureAccountSetup\(\{ identity: true \}\)/);
});
