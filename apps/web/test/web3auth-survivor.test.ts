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
