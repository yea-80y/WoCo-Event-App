/**
 * The durable "a Web3Auth session was established here" flag (#182).
 *
 * Properties pinned: the flag round-trips through a storage; a THROWING
 * storage reads as un-flagged (a storage that cannot hold our flag cannot
 * hold Web3Auth's session either, so there is nothing to end — the safe
 * direction is skipping the SDK build, not failing sign-out); and absence of
 * storage never throws into the auth flows that call these helpers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  markWeb3AuthSessionEstablished,
  clearWeb3AuthSessionFlag,
  hasWeb3AuthSessionFlag,
} from "../src/lib/auth/web3auth-session-flag.js";

function memStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

test("mark → has → clear round-trips", () => {
  const s = memStorage();
  assert.equal(hasWeb3AuthSessionFlag(s), false);
  markWeb3AuthSessionEstablished(s);
  assert.equal(hasWeb3AuthSessionFlag(s), true);
  clearWeb3AuthSessionFlag(s);
  assert.equal(hasWeb3AuthSessionFlag(s), false);
});

test("a throwing storage reads as un-flagged and never throws", () => {
  const broken = {
    getItem: () => { throw new Error("nope"); },
    setItem: () => { throw new Error("nope"); },
    removeItem: () => { throw new Error("nope"); },
  };
  assert.equal(hasWeb3AuthSessionFlag(broken), false);
  markWeb3AuthSessionEstablished(broken); // must not throw
  clearWeb3AuthSessionFlag(broken); // must not throw
});

test("no storage at all (node, private mode) is un-flagged and never throws", () => {
  assert.equal(hasWeb3AuthSessionFlag(null), false);
  markWeb3AuthSessionEstablished(null);
  clearWeb3AuthSessionFlag(null);
});
