/**
 * Ending a surviving Web3Auth session before an explicit authentication
 * (#182 login / #307 guardian connect — the shared helper both now use).
 *
 * The property pinned: a survivor is ENDED or the caller's flow REFUSES —
 * `connect()` after a swallowed logout failure would resolve as the survivor,
 * which at backup setup registers a stranger as the on-chain guardian.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  awaitWeb3AuthRehydration,
  endSurvivingWeb3AuthSession,
  instanceForExplicitSignIn,
  restoreVerdict,
  SURVIVOR_STILL_LOADING_MESSAGE,
  type Web3AuthSessionInstance,
} from "../src/lib/auth/web3auth-survivor.js";

/** A session that is up: what the SDK's logout() requires. */
const LIVE = { connected: true, status: "connected" } as const;

/** Mirrors the SDK's slice: event listeners on the instance, a logout that
 *  refuses unless the session is LIVE (the SDK's own precondition), and a cleanup
 *  logout that leaves the instance SPENT - connect() on it never works (#803). */
function fakeInstance(over: Partial<Web3AuthSessionInstance> = {}) {
  const calls: Array<{ cleanup?: boolean } | undefined> = [];
  const events = new EventEmitter();
  const w: Web3AuthSessionInstance & {
    calls: typeof calls;
    spent: boolean;
    emit: (event: string) => void;
  } = {
    connected: false,
    status: "ready",
    cachedConnector: null,
    logout: async (o) => {
      calls.push(o);
      if (!w.connected || !["connected", "authorized"].includes(w.status)) {
        throw new Error("Wallet is not connected. No wallet is connected");
      }
      w.connected = false;
      w.status = "ready";
      w.cachedConnector = null;
      if (o?.cleanup) w.spent = true;
    },
    on: (event, fn) => void events.on(event, fn),
    removeListener: (event, fn) => void events.removeListener(event, fn),
    emit: (event) => void events.emit(event),
    calls,
    spent: false,
    ...over,
  };
  return w;
}

test("a connected survivor is ended with cleanup before the caller may open the modal", async () => {
  const w = fakeInstance(LIVE);
  assert.equal(await endSurvivingWeb3AuthSession(w), true);
  assert.deepEqual(w.calls, [{ cleanup: true }]);
});

test("a fresh instance (no stored session) ends nothing and resolves instantly", async () => {
  const w = fakeInstance();
  assert.equal(await endSurvivingWeb3AuthSession(w), false);
  assert.deepEqual(w.calls, []);
});

test("a survivor that cannot be ended REJECTS — the caller must refuse, never adopt", async () => {
  const w = fakeInstance({
    ...LIVE,
    logout: async () => {
      throw new Error("network down");
    },
  });
  await assert.rejects(endSurvivingWeb3AuthSession(w), /network down/);
});

test("a STALE session the SDK already discarded resolves — logout throwing over nothing is the goal state (#507)", async () => {
  // What the owner hit: Web3Auth answers "Session Expired or Invalid public key"
  // during rehydration and drops the session itself, so logout() throws with
  // nothing connected. Refusing here told the user a network story and blocked a
  // first guardian sign-in that was already safe.
  const w = fakeInstance({ ...LIVE, cachedConnector: "auth" });
  w.logout = async () => {
    w.connected = false;
    w.cachedConnector = null;
    throw new Error("Session Expired or Invalid public key");
  };
  // Still `true`: logout was attempted, so this instance is spent too.
  assert.equal(await endSurvivingWeb3AuthSession(w), true);
});

test("logout failing with a cached connector STILL stored rejects — that session can answer connect()", async () => {
  const w = fakeInstance({ ...LIVE, cachedConnector: "auth" });
  w.logout = async () => {
    w.connected = false;
    throw new Error("network down");
  };
  await assert.rejects(endSurvivingWeb3AuthSession(w), /network down/);
});

// --- the wait (#803): a stored session still loading is not "no session" -----

test("a stored session that finishes loading inside the wait reads connected", async () => {
  const w = fakeInstance({ cachedConnector: "auth" });
  const wait = awaitWeb3AuthRehydration(w, 1_000);
  setTimeout(() => {
    w.connected = true;
    w.status = "connected";
    w.emit("connected");
  }, 10);
  assert.equal(await wait, "connected");
});

// --- a stored connector name is not a live session (owner's phone, 2026-10-09) --
// v10 reloads `connectedConnectorName` from localStorage when the instance is
// built, so `connected` is true straight after init() while the stored session is
// still reconnecting. Read as live, the cleanup's logout() went in early, the SDK
// refused ("No wallet is connected") with the session still standing, and every
// sign-in on that device failed with "couldn't be cleared".

/** What init() leaves when storage holds a session: named, cached, not yet up. */
const STORED = { connected: true, status: "ready", cachedConnector: "auth" } as const;

test("a stored connector name alone is never read as live", async () => {
  assert.equal(await awaitWeb3AuthRehydration(fakeInstance(STORED), 20), "pending");
});

test("the cleanup waits for a stored session to reconnect, then ends it", async () => {
  const w = fakeInstance(STORED);
  setTimeout(() => {
    w.status = "connected";
    w.emit("connected");
  }, 10);
  assert.equal(await endSurvivingWeb3AuthSession(w, 1_000), true);
  assert.deepEqual(w.calls, [{ cleanup: true }]);
});

test("a connected event before the status is live does not end the wait", async () => {
  const w = fakeInstance(STORED);
  const wait = awaitWeb3AuthRehydration(w, 1_000);
  setTimeout(() => w.emit("connected"), 5);
  setTimeout(() => {
    // The reconnect then fails: the SDK clears its cache and says so.
    w.connected = false;
    w.cachedConnector = null;
    w.emit("rehydration_error");
  }, 15);
  assert.equal(await wait, "none");
});

test("a stored session still loading when the wait runs out reads PENDING, never none", async () => {
  const w = fakeInstance({ cachedConnector: "auth" });
  assert.equal(await awaitWeb3AuthRehydration(w, 20), "pending");
});

test("a failed rehydration reads none once the SDK has cleared its cache", async () => {
  const w = fakeInstance({ cachedConnector: "auth" });
  const wait = awaitWeb3AuthRehydration(w, 1_000);
  setTimeout(() => {
    w.cachedConnector = null;
    w.emit("rehydration_error");
  }, 10);
  assert.equal(await wait, "none");
});

test("a failure event with the cache still set reads pending (never assume it is gone)", async () => {
  const w = fakeInstance({ cachedConnector: "auth" });
  const wait = awaitWeb3AuthRehydration(w, 1_000);
  setTimeout(() => w.emit("errored"), 10);
  assert.equal(await wait, "pending");
});

test("boot restore: still loading is UNAVAILABLE (stay signed in, retry), never expired", () => {
  assert.equal(restoreVerdict("pending", false), "unavailable");
  assert.equal(restoreVerdict("none", false), "expired");
  assert.equal(restoreVerdict("connected", true), "live");
  assert.equal(restoreVerdict("connected", false), "expired");
});

test("an explicit sign-in over a session still loading REFUSES and logs nothing out", async () => {
  const w = fakeInstance({ cachedConnector: "auth" });
  await assert.rejects(endSurvivingWeb3AuthSession(w, 20), { message: SURVIVOR_STILL_LOADING_MESSAGE });
  assert.deepEqual(w.calls, []);
});

// --- never connect() on the instance that logged out (#803) ------------------

test("no survivor: the same instance is used and nothing is rebuilt", async () => {
  const w = fakeInstance();
  let rebuilt = 0;
  const ready = await instanceForExplicitSignIn(w, async () => {
    rebuilt++;
    return fakeInstance();
  });
  assert.equal(ready, w);
  assert.equal(rebuilt, 0);
});

test("a survivor is ended and the SPENT instance swapped for a fresh one", async () => {
  const w = fakeInstance(LIVE);
  const fresh = fakeInstance();
  const ready = await instanceForExplicitSignIn(w, async () => fresh);
  assert.deepEqual(w.calls, [{ cleanup: true }]);
  assert.equal(w.spent, true);
  assert.equal(ready, fresh);
  assert.equal(ready.spent, false);
});

test("the #507 stale-session path also swaps the instance it touched", async () => {
  const w = fakeInstance({ ...LIVE, cachedConnector: "auth" });
  w.logout = async () => {
    w.connected = false;
    w.cachedConnector = null;
    w.spent = true;
    throw new Error("Session Expired or Invalid public key");
  };
  const fresh = fakeInstance();
  assert.equal(await instanceForExplicitSignIn(w, async () => fresh), fresh);
});

test("a second survivor on the fresh instance refuses rather than loop", async () => {
  const w = fakeInstance(LIVE);
  await assert.rejects(
    instanceForExplicitSignIn(w, async () => fakeInstance(LIVE)),
    /interfered/,
  );
});

test("a survivor that cannot be ended never reaches a rebuild", async () => {
  const w = fakeInstance({
    ...LIVE,
    logout: async () => {
      throw new Error("network down");
    },
  });
  let rebuilt = 0;
  await assert.rejects(
    instanceForExplicitSignIn(w, async () => {
      rebuilt++;
      return fakeInstance();
    }),
    /network down/,
  );
  assert.equal(rebuilt, 0);
});
