/**
 * The Web3Auth sign-in, reload restore and sign-out paths (`web3auth-account.ts`),
 * against a fake SDK that keeps the real one's two traps (#803):
 *
 *  - a stored session lives in storage SHARED by every instance, and loads
 *    asynchronously after init() - yet `connected` reads true from the moment
 *    the instance is built, because the SDK reloads the connector's NAME from
 *    storage; only `status` says whether it is live, and logout() refuses until
 *    it is (the owner's phone, 2026-10-09);
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

const { loginWithWeb3Auth, restoreWeb3AuthSession, logoutWeb3Auth, cancelWeb3AuthSignIn, setWeb3AuthFactoryForTests } =
  await import("../src/lib/auth/web3auth-account.js");
const { SURVIVOR_STILL_LOADING_MESSAGE, SURVIVOR_INTERFERED_MESSAGE } = await import(
  "../src/lib/auth/web3auth-survivor.js"
);
const { isWeb3AuthSignInError, WEB3AUTH_TIMED_OUT_MESSAGE } = await import("../src/lib/auth/web3auth-signin-error.js");
const { SIGN_IN_POLL_MS, SIGN_IN_STALL_AFTER_WATCHED_MS, SIGN_IN_GRACE_MS } = await import(
  "../src/lib/auth/web3auth-signin-wait.js"
);
type SignInWaitDeps = import("../src/lib/auth/web3auth-signin-wait.js").SignInWaitDeps;

/** The page the sign-in wait watches: scripted, so no real timers (web3auth-signin-wait.test.ts has the unit tests). */
class Page {
  watching = false;
  listeners = new Set<() => void>();
  polls = new Map<unknown, () => void>();
  deps = (): SignInWaitDeps => ({
    listen: (fn) => {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    },
    watching: () => this.watching,
    setInterval: (fn) => {
      const h = {};
      this.polls.set(h, fn);
      return h;
    },
    clearInterval: (h) => void this.polls.delete(h),
  });
  tick(ms: number): void {
    for (let t = 0; t < ms; t += SIGN_IN_POLL_MS) for (const fn of [...this.polls.values()]) fn();
  }
}

const KEY_A = "11".repeat(32);
const KEY_B = "22".repeat(32);
const addressOf = (k: string) => privateKeyToAccount(`0x${k}`).address.toLowerCase();

/** What the browser's storage holds for Web3Auth: one session, shared by every instance. */
type Stored = { key: string; loads: "at-init" | "later" | "never" } | null;

const LIVE_STATUSES = ["connected", "authorized"];

/** The SDK's provider exists from init(), session or not (noModal.js:71); it
 *  serves the key only once a session is bound to it. */
const unboundProvider = () => ({
  request: async (): Promise<unknown> => {
    throw new Error("no session bound to the provider yet");
  },
});

class FakeSdk extends EventEmitter {
  connected = false;
  status = "not_ready";
  provider: { request: (a: { method: string }) => Promise<unknown> } | null = null;
  cachedConnector: string | null = null;
  spent = false;
  connectCalls = 0;
  logouts: Array<{ cleanup?: boolean } | undefined> = [];
  modalClosed = 0;
  /** A connect() waiting on its pop-up; the modal's close settles it as a cancel
   *  (modalManager.connect's MODAL_VISIBILITY handler) unless it had connected. */
  pendingConnect: { reject: (e: Error) => void } | null = null;
  loginModal = {
    closeModal: () => {
      this.modalClosed++;
      if (this.pendingConnect && !LIVE_STATUSES.includes(this.status)) {
        this.pendingConnect.reject(new Error("User closed the modal"));
        this.pendingConnect = null;
      }
    },
  };

  constructor(
    private world: World,
    private nextLoginKey: string,
  ) {
    super();
  }

  async init(): Promise<void> {
    this.status = "ready";
    this.provider = unboundProvider();
    const s = this.world.stored;
    if (!s) return;
    this.cachedConnector = "auth";
    this.connected = true;
    if (s.loads === "at-init") this.hydrate(s.key);
  }

  /** The stored session finishes loading (the SDK's async rehydration; its
   *  CONNECTED event says `reconnected: true`, authConnector.js). */
  hydrate(key: string): void {
    this.connected = true;
    this.status = "connected";
    this.provider = { request: async () => key };
    this.emit("connected", { reconnected: true });
  }

  /** The pop-up's result reaches the connector AFTER the modal's promise is
   *  gone (closed by our stall, or never answered): a connection this sign-in
   *  made, `reconnected: false`, that nothing resolves on its own. */
  lateResult(key: string): void {
    this.connected = true;
    this.status = "connected";
    this.cachedConnector = "auth";
    this.world.stored = { key, loads: "at-init" };
    this.provider = { request: async () => key };
    this.emit("connected", { reconnected: false });
  }

  async connect() {
    this.connectCalls++;
    if (this.spent) throw new Error("connect() on a spent instance - the real SDK never settles here (#803)");
    if (this.world.popupNeverAnswers) {
      // The pop-up's result never reaches this page: connect() waits forever.
      await new Promise<never>((_, reject) => {
        this.pendingConnect = { reject };
      });
    }
    const fail = this.world.connectFails;
    if (fail) {
      if (fail === "survivor-mid-modal") this.hydrate(KEY_A);
      throw fail === "popup-closed"
        ? Object.assign(new Error("Wallet popup has been closed by the user"), { code: 5114 })
        : fail === "modal-closed" || fail === "survivor-mid-modal"
          ? new Error("User closed the modal")
          : new Error("boom");
    }
    this.connected = true;
    this.status = "connected";
    this.cachedConnector = "auth";
    this.world.stored = { key: this.nextLoginKey, loads: "at-init" };
    const key = this.nextLoginKey;
    this.provider = { request: async () => key };
    return this.provider;
  }

  async logout(o?: { cleanup?: boolean }): Promise<void> {
    this.logouts.push(o);
    if (!this.connected || !LIVE_STATUSES.includes(this.status)) throw new Error("No wallet is connected");
    // The SDK's early return while a connector is still DISCONNECTING.
    if (this.world.logoutNoop) return;
    this.connected = false;
    this.status = "ready";
    this.provider = unboundProvider();
    this.cachedConnector = null;
    this.world.stored = null;
    if (o?.cleanup) this.spent = true;
    if (this.world.logoutGate) await this.world.logoutGate;
  }
}

class World {
  stored: Stored = null;
  built: FakeSdk[] = [];
  /** The key the modal yields when someone completes a sign-in in it. */
  loginKey = KEY_B;
  failInit = false;
  connectFails: "popup-closed" | "modal-closed" | "survivor-mid-modal" | "other" | null = null;
  /** Holds a logout open AFTER its state change, like a slow network round trip. */
  logoutGate: Promise<void> | null = null;
  /** logout() resolves having ended nothing - the session stays named and stored. */
  logoutNoop = false;
  /** The sign-in pop-up completes (or not) somewhere this page never hears about. */
  popupNeverAnswers = false;
  page = new Page();

  install(): void {
    setWeb3AuthFactoryForTests(async () => {
      if (this.failInit) throw new Error("init failed");
      const sdk = new FakeSdk(this, this.loginKey);
      this.built.push(sdk);
      await sdk.init();
      return sdk;
    }, this.page.deps);
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
  assert.equal(world.built[0].modalClosed, 1, "the SDK's success screen never sits over ours");
});

for (const how of ["popup-closed", "modal-closed"] as const) {
  test(`backing out (${how}) is a quiet cancel, and the SDK's modal is closed behind it`, async () => {
    world.connectFails = how;
    await assert.rejects(loginWithWeb3Auth(), (e: unknown) => {
      assert.ok(isWeb3AuthSignInError(e) && e.cancelled);
      return true;
    });
    assert.equal(world.built[0].modalClosed, 1, "no live modal left for a second tap nobody receives");
    world.connectFails = null;
    await loginWithWeb3Auth();
    assert.equal(world.built.length, 1, "a cancel leaves a usable instance");
  });
}

test("a pop-up whose result never comes back can be cancelled from our sheet: the SDK's modal is closed and the wait settles as a cancel", async () => {
  world.popupNeverAnswers = true;
  const attempt = loginWithWeb3Auth();
  const outcome = assert.rejects(attempt, (e: unknown) => {
    assert.ok(isWeb3AuthSignInError(e) && e.cancelled, "a quiet cancel, nothing to show");
    return true;
  });
  await settle();
  const sdk = world.built[0];
  assert.equal(sdk.connectCalls, 1);
  assert.ok(sdk.pendingConnect, "still waiting on the pop-up");
  cancelWeb3AuthSignIn();
  await outcome;
  // Once from the cancel (which is what settled it), once from the settled sign-in.
  assert.equal(sdk.modalClosed, 2);
  world.popupNeverAnswers = false;
  const r = await loginWithWeb3Auth();
  assert.equal(r.address, addressOf(KEY_B), "the instance is still usable afterwards");
  assert.equal(world.built.length, 1);
});

test("cancelling with no sign-in under way does nothing", async () => {
  cancelWeb3AuthSignIn();
  assert.equal(world.built.length, 0, "never builds the SDK");
});

// --- the late result (an iPhone, 2026-10-10) -----------------------------------

test("a result that reaches the connector while the modal's promise never settles signs the person in by itself", async () => {
  world.popupNeverAnswers = true;
  const attempt = loginWithWeb3Auth();
  await settle();
  const sdk = world.built[0];
  assert.ok(sdk.pendingConnect, "the SDK's promise is still open");
  sdk.lateResult(KEY_B);
  const r = await attempt;
  assert.equal(r.address, addressOf(KEY_B));
  assert.equal(sdk.modalClosed, 1, "the SDK's success screen never sits over ours");
  assert.equal(memory.get("woco:web3auth-session-established"), "1");
});

test("the spinner is bounded: watched time runs out, the SDK's loader is closed, the sheet is told, and a result in the grace still signs in", async () => {
  world.popupNeverAnswers = true;
  let stalls = 0;
  const attempt = loginWithWeb3Auth({ onStall: () => stalls++ });
  await settle();
  const sdk = world.built[0];
  world.page.watching = true;
  world.page.tick(SIGN_IN_STALL_AFTER_WATCHED_MS);
  assert.equal(stalls, 1);
  assert.equal(sdk.modalClosed, 1, "the loader with no close of its own is closed for the person");
  await settle();
  assert.equal(sdk.pendingConnect, null, "the SDK's promise was settled by that close (a cancel) - and ignored");
  world.page.tick(45 * SIGN_IN_POLL_MS); // the socket's own ping timeout, then its re-ask
  sdk.lateResult(KEY_B);
  const r = await attempt;
  assert.equal(r.address, addressOf(KEY_B), "picked up with no action from the person");
  assert.equal(sdk.modalClosed, 2);
});

test("a stalled wait with nothing in the grace ends with the retry message, and the instance stays usable", async () => {
  world.popupNeverAnswers = true;
  const attempt = loginWithWeb3Auth();
  const outcome = assert.rejects(attempt, (e: unknown) => {
    assert.ok(isWeb3AuthSignInError(e) && e.timedOut && !e.cancelled);
    assert.equal((e as Error).message, WEB3AUTH_TIMED_OUT_MESSAGE);
    assert.match((e as Error).message, /Try again/);
    return true;
  });
  await settle();
  world.page.watching = true;
  world.page.tick(SIGN_IN_STALL_AFTER_WATCHED_MS + SIGN_IN_GRACE_MS);
  await outcome;
  world.popupNeverAnswers = false;
  const r = await loginWithWeb3Auth();
  assert.equal(r.address, addressOf(KEY_B));
  assert.equal(world.built.length, 1);
});

test("closing our sheet during a stall ends the wait as a quiet cancel", async () => {
  world.popupNeverAnswers = true;
  const attempt = loginWithWeb3Auth();
  const outcome = assert.rejects(attempt, (e: unknown) => {
    assert.ok(isWeb3AuthSignInError(e) && e.cancelled);
    return true;
  });
  await settle();
  world.page.watching = true;
  world.page.tick(SIGN_IN_STALL_AFTER_WATCHED_MS);
  await settle();
  cancelWeb3AuthSignIn();
  await outcome;
  assert.equal(world.page.polls.size, 0, "nothing left polling");
});

test("a session that rehydrates mid-wait is never picked up by the re-check (#182)", async () => {
  world.popupNeverAnswers = true;
  const attempt = loginWithWeb3Auth();
  const outcome = assert.rejects(attempt, { name: "Web3AuthSignInError", message: SURVIVOR_INTERFERED_MESSAGE });
  await settle();
  const sdk = world.built[0];
  sdk.hydrate(KEY_A);
  world.page.tick(5 * SIGN_IN_POLL_MS);
  await settle();
  assert.ok(sdk.pendingConnect, "not adopted: the wait is still open");
  cancelWeb3AuthSignIn();
  await outcome;
  assert.deepEqual(sdk.logouts, [{ cleanup: true }], "ended, as before");
});

test("any other sign-in failure is passed on as itself, modal closed", async () => {
  world.connectFails = "other";
  await assert.rejects(loginWithWeb3Auth(), (e: unknown) => {
    assert.ok(!isWeb3AuthSignInError(e));
    assert.equal((e as Error).message, "boom");
    return true;
  });
  assert.equal(world.built[0].modalClosed, 1);
});

test("a session that appears mid-modal is ended, never adopted, and the next try is fresh", async () => {
  world.connectFails = "survivor-mid-modal";
  await assert.rejects(loginWithWeb3Auth(), { name: "Web3AuthSignInError", message: SURVIVOR_INTERFERED_MESSAGE });
  assert.deepEqual(world.built[0].logouts, [{ cleanup: true }]);
  world.connectFails = null;
  const r = await loginWithWeb3Auth();
  assert.equal(r.address, addressOf(KEY_B));
  assert.equal(world.built.length, 2);
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
    await assert.rejects(loginWithWeb3Auth(), (e: unknown) => {
      assert.ok(isWeb3AuthSignInError(e) && !e.cancelled);
      assert.match((e as Error).message, /couldn't be cleared - check your connection/);
      return true;
    });
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

test("a logout that resolves without ending the session refuses - never reported as cleared", async () => {
  world.stored = { key: KEY_A, loads: "at-init" };
  world.logoutNoop = true;
  await assert.rejects(loginWithWeb3Auth(), (e: unknown) => {
    assert.ok(isWeb3AuthSignInError(e));
    assert.match((e as Error).message, /couldn't be cleared/);
    return true;
  });
  assert.deepEqual(world.built.map((b) => b.connectCalls), [0], "no modal over a session still stored");
  assert.notEqual(world.stored, null);
});

test("sign-in over a session still loading waits, then refuses without signing anyone in", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  world.stored = { key: KEY_A, loads: "never" };
  const attempt = loginWithWeb3Auth();
  const outcome = assert.rejects(attempt, { name: "Web3AuthSignInError", message: SURVIVOR_STILL_LOADING_MESSAGE });
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

test("a sign-in that arrives while a sign-out is still finishing never connects on the logged-out instance", async () => {
  memory.set("woco:web3auth-session-established", "1");
  world.stored = { key: KEY_A, loads: "at-init" };
  let release!: () => void;
  world.logoutGate = new Promise<void>((r) => (release = r));
  const out = logoutWeb3Auth();
  await settle(); // the instance is logged out; the sign-out has not reset the singleton yet
  await assert.rejects(loginWithWeb3Auth(), { name: "Web3AuthSignInError", message: SURVIVOR_INTERFERED_MESSAGE });
  assert.equal(world.built[0].connectCalls, 0, "the spent instance is never asked to sign in");
  release();
  world.logoutGate = null;
  await out;
  const r = await loginWithWeb3Auth();
  assert.equal(r.address, addressOf(KEY_B));
  assert.equal(world.built.at(-1)!.connectCalls, 1);
});

test("a reload that was slow and then fails reads unavailable first, expired after, and clears the flag", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  memory.set("woco:web3auth-session-established", "1");
  world.stored = { key: KEY_A, loads: "later" };
  const first = restoreWeb3AuthSession();
  await settle();
  t.mock.timers.tick(5_000);
  assert.deepEqual(await first, { status: "unavailable" });
  assert.equal(memory.get("woco:web3auth-session-established"), "1", "not a verdict yet");
  const sdk = world.built[0];
  const retry = restoreWeb3AuthSession();
  await settle();
  sdk.cachedConnector = null; // the SDK clears its cache, then reports the failure
  sdk.emit("rehydration_error");
  assert.deepEqual(await retry, { status: "expired" });
  assert.equal(memory.has("woco:web3auth-session-established"), false);
});
