/**
 * The Web3Auth sign-in, reload restore and sign-out paths (`web3auth-account.ts`),
 * against a fake SDK that keeps the real one's two traps (#803):
 *
 *  - a stored session lives in storage SHARED by every instance, and loads
 *    asynchronously after init();
 *  - `logout({ cleanup: true })` leaves the instance SPENT. The real SDK then
 *    swallows every sign-in click and connect() never settles; the fake throws
 *    instead, so a regression fails here rather than hanging.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { privateKeyToAccount } from "viem/accounts";

// Loaded once up front: the rehydration wait imports the SDK for its event
// names, and the mocked-clock tests need that import already cached.
await import("@web3auth/modal");

const memory = new Map<string, string>();
(globalThis as unknown as { localStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> }).localStorage = {
  getItem: (k) => memory.get(k) ?? null,
  setItem: (k, v) => void memory.set(k, v),
  removeItem: (k) => void memory.delete(k),
};

const { loginWithWeb3Auth, restoreWeb3AuthSession, logoutWeb3Auth, setWeb3AuthFactoryForTests } = await import(
  "../src/lib/auth/web3auth-account.js"
);
const { SURVIVOR_STILL_LOADING_MESSAGE } = await import("../src/lib/auth/web3auth-survivor.js");

const KEY_A = "11".repeat(32);
const KEY_B = "22".repeat(32);
const addressOf = (k: string) => privateKeyToAccount(`0x${k}`).address.toLowerCase();

/** What the browser's storage holds for Web3Auth: one session, shared by every instance. */
type Stored = { key: string; loads: "at-init" | "later" | "never" } | null;

class FakeSdk extends EventEmitter {
  connected = false;
  provider: { request: (a: { method: string }) => Promise<unknown> } | null = null;
  cachedConnector: string | null = null;
  spent = false;
  connectCalls = 0;
  logouts: Array<{ cleanup?: boolean } | undefined> = [];

  constructor(
    private world: World,
    private nextLoginKey: string,
  ) {
    super();
  }

  async init(): Promise<void> {
    const s = this.world.stored;
    if (!s) return;
    this.cachedConnector = "auth";
    if (s.loads === "at-init") this.hydrate(s.key);
  }

  /** The stored session finishes loading (the SDK's async rehydration). */
  hydrate(key: string): void {
    this.connected = true;
    this.provider = { request: async () => key };
    this.emit("connected");
  }

  async connect() {
    this.connectCalls++;
    if (this.spent) throw new Error("connect() on a spent instance - the real SDK never settles here (#803)");
    this.connected = true;
    this.cachedConnector = "auth";
    this.world.stored = { key: this.nextLoginKey, loads: "at-init" };
    const key = this.nextLoginKey;
    this.provider = { request: async () => key };
    return this.provider;
  }

  async logout(o?: { cleanup?: boolean }): Promise<void> {
    this.logouts.push(o);
    if (!this.connected) throw new Error("No wallet is connected");
    this.connected = false;
    this.provider = null;
    this.cachedConnector = null;
    this.world.stored = null;
    if (o?.cleanup) this.spent = true;
  }
}

class World {
  stored: Stored = null;
  built: FakeSdk[] = [];
  /** The key the modal yields when someone completes a sign-in in it. */
  loginKey = KEY_B;
  failInit = false;

  install(): void {
    setWeb3AuthFactoryForTests(async () => {
      if (this.failInit) throw new Error("init failed");
      const sdk = new FakeSdk(this, this.loginKey);
      this.built.push(sdk);
      await sdk.init();
      return sdk;
    });
  }
}

let world: World;
beforeEach(() => {
  memory.clear();
  world = new World();
  world.install();
});

/** Let pending promise chains (and the cached SDK import) run without moving the clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

// --- sign-in -----------------------------------------------------------------

test("sign-in with nothing stored: one instance, the modal's key comes back", async () => {
  const r = await loginWithWeb3Auth();
  assert.equal(r.address, addressOf(KEY_B));
  assert.equal(world.built.length, 1);
  assert.equal(memory.get("woco:web3auth-session-established"), "1");
});

test("#803: a leftover session is ended and sign-in completes on a FRESH instance", async () => {
  world.stored = { key: KEY_A, loads: "at-init" };
  const r = await loginWithWeb3Auth();
  const [first, second] = world.built;
  assert.deepEqual(first.logouts, [{ cleanup: true }], "the leftover is ended, never adopted");
  assert.equal(first.connectCalls, 0, "the spent instance is never asked to sign in");
  assert.equal(second.connectCalls, 1);
  assert.equal(r.address, addressOf(KEY_B), "the person who signed in, not the leftover");
});

test("a leftover that cannot be ended refuses, and the next attempt starts from a new instance", async () => {
  world.stored = { key: KEY_A, loads: "at-init" };
  const realLogout = FakeSdk.prototype.logout;
  FakeSdk.prototype.logout = async function () {
    throw new Error("network down");
  };
  try {
    await assert.rejects(loginWithWeb3Auth(), /network down/);
  } finally {
    FakeSdk.prototype.logout = realLogout;
  }
  assert.equal(world.built.length, 1);
  // Still stored, so the retry builds anew, ends it, and signs in on a third.
  const r = await loginWithWeb3Auth();
  assert.equal(r.address, addressOf(KEY_B));
  assert.equal(world.built.length, 3, "the refused attempt's instance is not reused");
  assert.deepEqual(world.built.map((b) => b.connectCalls), [0, 0, 1]);
});

test("sign-in over a session still loading waits, then refuses without signing anyone in", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  world.stored = { key: KEY_A, loads: "never" };
  const attempt = loginWithWeb3Auth();
  const outcome = assert.rejects(attempt, { message: SURVIVOR_STILL_LOADING_MESSAGE });
  await settle();
  t.mock.timers.tick(20_000);
  await outcome;
  assert.equal(world.built[0].connectCalls, 0, "the modal never opens over a loading session");
  assert.deepEqual(world.built[0].logouts, []);
});

test("a leftover that finishes loading during the wait is ended, then sign-in proceeds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  world.stored = { key: KEY_A, loads: "later" };
  const attempt = loginWithWeb3Auth();
  await settle();
  t.mock.timers.tick(3_000);
  world.built[0].hydrate(KEY_A);
  const r = await attempt;
  assert.equal(r.address, addressOf(KEY_B));
  assert.equal(world.built[0].connectCalls, 0);
});

// --- restore on reload -------------------------------------------------------

test("reload with nothing stored: expired, and the sign-out flag is cleared", async () => {
  memory.set("woco:web3auth-session-established", "1");
  assert.deepEqual(await restoreWeb3AuthSession(), { status: "expired" });
  assert.equal(memory.has("woco:web3auth-session-established"), false);
});

test("reload with a live stored session: restored with its key", async () => {
  world.stored = { key: KEY_A, loads: "at-init" };
  const r = await restoreWeb3AuthSession();
  assert.equal(r.status, "restored");
  assert.equal(r.status === "restored" && r.address, addressOf(KEY_A));
});

test("#803: a reload whose session is still loading after the wait stays signed in, and the retry restores it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  world.stored = { key: KEY_A, loads: "later" };
  const first = restoreWeb3AuthSession();
  await settle();
  t.mock.timers.tick(5_000);
  assert.deepEqual(await first, { status: "unavailable" }, "slow is not signed out");
  world.built[0].hydrate(KEY_A);
  const retry = await restoreWeb3AuthSession();
  assert.equal(retry.status, "restored");
  assert.equal(world.built.length, 1, "the retry reads the same instance");
});

test("reload when the SDK cannot start: unavailable, never expired", async () => {
  world.failInit = true;
  assert.deepEqual(await restoreWeb3AuthSession(), { status: "unavailable" });
});

test("a restore and a sign-in click arriving together build ONE instance", async () => {
  await Promise.all([restoreWeb3AuthSession(), restoreWeb3AuthSession()]);
  assert.equal(world.built.length, 1);
});

// --- sign-out ----------------------------------------------------------------

test("sign-out ends the live session, and the next sign-in builds a fresh instance", async () => {
  await loginWithWeb3Auth();
  await logoutWeb3Auth();
  assert.deepEqual(world.built[0].logouts, [{ cleanup: true }]);
  assert.equal(world.stored, null);
  assert.equal(memory.has("woco:web3auth-session-established"), false);
  await loginWithWeb3Auth();
  assert.equal(world.built.length, 2);
  assert.equal(world.built[0].connectCalls, 1, "the signed-out instance is never reused");
});

test("sign-out over a session still loading fails loudly rather than claim it ended", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  memory.set("woco:web3auth-session-established", "1");
  world.stored = { key: KEY_A, loads: "never" };
  const out = assert.rejects(logoutWeb3Auth(), /may still be signed in/);
  await settle();
  t.mock.timers.tick(20_000);
  await out;
  assert.equal(memory.get("woco:web3auth-session-established"), "1", "the flag stays until the session is known ended");
});

test("sign-out with no session ever established here never builds the SDK", async () => {
  await logoutWeb3Auth();
  assert.equal(world.built.length, 0);
});

test("an instance still being built when the page drops it never installs itself afterwards", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const stale = new FakeSdk(world, KEY_A);
  setWeb3AuthFactoryForTests(async () => {
    await gate;
    return stale;
  });
  const pending = restoreWeb3AuthSession();
  world.install(); // drops the instance mid-build
  release();
  await pending;
  await restoreWeb3AuthSession();
  assert.equal(world.built.length, 1, "the next read builds afresh instead of adopting the stale build");
});

test("sign-out gives a slow session longer than a reload does, then ends it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  memory.set("woco:web3auth-session-established", "1");
  world.stored = { key: KEY_A, loads: "later" };
  const out = logoutWeb3Auth();
  await settle();
  t.mock.timers.tick(10_000); // past the 5 s reload window
  world.built[0].hydrate(KEY_A);
  await out;
  assert.deepEqual(world.built[0].logouts, [{ cleanup: true }]);
  assert.equal(world.stored, null);
});
