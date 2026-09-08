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
import {
  endSurvivingWeb3AuthSession,
  type Web3AuthSessionInstance,
} from "../src/lib/auth/web3auth-survivor.js";

function fakeInstance(over: Partial<Web3AuthSessionInstance> = {}) {
  const calls: Array<{ cleanup?: boolean } | undefined> = [];
  const w: Web3AuthSessionInstance & { calls: typeof calls } = {
    connected: false,
    cachedConnector: null,
    logout: async (o) => void calls.push(o),
    on: () => {},
    removeListener: () => {},
    calls,
    ...over,
  };
  return w;
}

test("a connected survivor is ended with cleanup before the caller may open the modal", async () => {
  const w = fakeInstance({ connected: true });
  await endSurvivingWeb3AuthSession(w);
  assert.deepEqual(w.calls, [{ cleanup: true }]);
});

test("a fresh instance (no stored session) ends nothing and resolves instantly", async () => {
  const w = fakeInstance();
  await endSurvivingWeb3AuthSession(w);
  assert.deepEqual(w.calls, []);
});

test("a survivor that cannot be ended REJECTS — the caller must refuse, never adopt", async () => {
  const w = fakeInstance({
    connected: true,
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
  const w = fakeInstance({ connected: true, cachedConnector: "auth" });
  w.logout = async () => {
    w.connected = false;
    w.cachedConnector = null;
    throw new Error("Session Expired or Invalid public key");
  };
  await endSurvivingWeb3AuthSession(w);
});

test("logout failing with a cached connector STILL stored rejects — that session can answer connect()", async () => {
  const w = fakeInstance({ connected: true, cachedConnector: "auth" });
  w.logout = async () => {
    w.connected = false;
    throw new Error("network down");
  };
  await assert.rejects(endSurvivingWeb3AuthSession(w), /network down/);
});
