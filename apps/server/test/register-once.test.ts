/**
 * Exactly-once registration.
 *
 * The invariant under test is narrow and expensive to get wrong: `registerEvent`
 * must be broadcast AT MOST ONCE per (event, series). The contract derives the
 * on-chain id from a sponsor-nonce counter, not the manifest (WoCoEventV2.sol:247),
 * so a second send is not a no-op — it mints a second event with its own supply.
 * Every test here therefore asserts on the number of broadcasts, not just the id.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventFeed } from "@woco/shared";
import {
  registerSeriesExactlyOnce,
  type RegisterDeps,
  type RegisterParams,
} from "../src/lib/event/register-once.js";

const PARAMS: RegisterParams = {
  eventId: "evt-1",
  seriesId: "ser-1",
  supply: 100,
  manifestRef: "0xabc",
  v2Params: { priceBaseUnits: 0n, payoutRecipient: "0xcreator", dropGate: "0x0", eventEndTs: 9_999_999_999 },
};

const FEED = { eventId: "evt-1" } as unknown as EventFeed;

/** In-memory stand-ins for the two persisted stores + the chain. */
function harness(over: Partial<RegisterDeps> = {}) {
  const registry = new Map<string, string>();
  const pending = new Map<string, { txHash: string; nonce: number; chainId: number; at: string }>();
  const calls = { broadcasts: 0, confirms: 0, resolves: 0 };

  const deps: RegisterDeps = {
    lookupOnChainEventId: (e, s) => registry.get(`${e}|${s}`) ?? null,
    lookupPending: (e, s) => pending.get(`${e}|${s}`) ?? null,
    recordPending: (e, s, tx) => void pending.set(`${e}|${s}`, { ...tx, at: "now" }),
    clearPending: (e, s) => void pending.delete(`${e}|${s}`),
    resolveRegisterTx: async () => {
      calls.resolves++;
      return { status: "pending" as const, txHash: "0xtx" } as never;
    },
    registerEventOnChain: (async (_supply, _ref, _v2, onTxSent) => {
      calls.broadcasts++;
      onTxSent?.({ txHash: "0xtx1", nonce: 7, chainId: 421614 });
      return { onChainEventId: "0xonchain1", txHash: "0xtx1" };
    }) as RegisterDeps["registerEventOnChain"],
    confirmSeriesOnChain: (async (e, s, id) => {
      calls.confirms++;
      registry.set(`${e}|${s}`, id); // mirrors recordOnChainEventId running first
      return FEED;
    }) as RegisterDeps["confirmSeriesOnChain"],
    ...over,
  };

  return { deps, registry, pending, calls };
}

test("happy path: broadcasts once, records the id, clears the pending marker", async () => {
  const h = harness();

  const r = await registerSeriesExactlyOnce(PARAMS, h.deps);

  assert.equal(r.status, "registered");
  assert.equal(h.calls.broadcasts, 1);
  assert.equal(h.registry.get("evt-1|ser-1"), "0xonchain1");
  assert.equal(h.pending.size, 0, "marker must not outlive a completed registration");
});

test("the observed bug: tx landed, feed write failed — a retry heals, it does NOT re-broadcast", async () => {
  // Attempt 1: the tx mines, confirmSeriesOnChain records the id and then throws
  // (this is exactly what the route's "Tx confirmed but feed update failed — retry"
  // 500 reports). The registry keeps the id; the feed never gets it.
  let failConfirm = true;
  const h = harness();
  const confirm = h.deps.confirmSeriesOnChain;
  h.deps.confirmSeriesOnChain = (async (e, s, id, hint) => {
    if (failConfirm) {
      h.registry.set(`${e}|${s}`, id); // recordOnChainEventId is confirm's FIRST statement
      throw new Error("Swarm feed write failed");
    }
    return confirm(e, s, id, hint);
  }) as RegisterDeps["confirmSeriesOnChain"];

  await assert.rejects(registerSeriesExactlyOnce(PARAMS, h.deps), /feed write failed/);
  assert.equal(h.calls.broadcasts, 1);

  // Attempt 2 — the retry the 500 invites. Must adopt the existing id.
  failConfirm = false;
  const r = await registerSeriesExactlyOnce(PARAMS, h.deps);

  assert.equal(r.status, "already");
  assert.equal(r.onChainEventId, "0xonchain1");
  assert.equal(h.calls.broadcasts, 1, "a second registerEvent would mint a SECOND on-chain event");
  assert.equal(h.pending.size, 0);
});

test("crash between broadcast and confirm: the marker resolves the tx instead of re-sending", async () => {
  // Server dies after broadcast — nothing reached the registry, but the marker did.
  const h = harness({
    registerEventOnChain: (async (_s, _r, _v, onTxSent) => {
      onTxSent?.({ txHash: "0xtx1", nonce: 7, chainId: 421614 });
      throw new Error("process died awaiting receipt");
    }) as RegisterDeps["registerEventOnChain"],
  });
  await assert.rejects(registerSeriesExactlyOnce(PARAMS, h.deps));
  assert.equal(h.pending.get("evt-1|ser-1")?.txHash, "0xtx1");

  // Restart: the tx turns out to have mined. Adopt its id — do not send another.
  const h2 = harness({
    lookupPending: () => ({ txHash: "0xtx1", nonce: 7, chainId: 421614, at: "then" }),
    resolveRegisterTx: async () => ({ status: "registered", onChainEventId: "0xonchain1", txHash: "0xtx1" }),
  });
  const r = await registerSeriesExactlyOnce(PARAMS, h2.deps);

  assert.equal(r.status, "registered");
  assert.equal(r.onChainEventId, "0xonchain1");
  assert.equal(h2.calls.broadcasts, 0, "the tx already exists on chain — re-sending duplicates it");
});

test("a tx still in the mempool is never re-sent — the caller is told to come back", async () => {
  const h = harness({
    lookupPending: () => ({ txHash: "0xtx1", nonce: 7, chainId: 421614, at: "then" }),
    resolveRegisterTx: async () => ({ status: "pending" }),
  });

  const r = await registerSeriesExactlyOnce(PARAMS, h.deps);

  assert.equal(r.status, "pending");
  assert.equal(h.calls.broadcasts, 0, "re-sending over an in-flight tx is the duplicate-mint bug");
});

for (const status of ["reverted", "replaced"] as const) {
  test(`a ${status} tx registered nothing, so a fresh broadcast is allowed`, async () => {
    let firstLookup = true;
    const h = harness({
      lookupPending: () => {
        if (!firstLookup) return null;
        firstLookup = false;
        return { txHash: "0xdead", nonce: 7, chainId: 421614, at: "then" };
      },
      resolveRegisterTx: async () => ({ status }),
    });

    const r = await registerSeriesExactlyOnce(PARAMS, h.deps);

    assert.equal(r.status, "registered");
    assert.equal(h.calls.broadcasts, 1);
    assert.equal(h.pending.size, 0);
  });
}

test("concurrent callers join one registration — a double-click cannot double-mint", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = harness({
    registerEventOnChain: (async (_s, _r, _v, onTxSent) => {
      await gate;
      onTxSent?.({ txHash: "0xtx1", nonce: 7, chainId: 421614 });
      return { onChainEventId: "0xonchain1", txHash: "0xtx1" };
    }) as RegisterDeps["registerEventOnChain"],
  });

  const a = registerSeriesExactlyOnce(PARAMS, h.deps);
  const b = registerSeriesExactlyOnce(PARAMS, h.deps);
  release();
  const [ra, rb] = await Promise.all([a, b]);

  assert.equal(ra.onChainEventId, "0xonchain1");
  assert.equal(rb.onChainEventId, "0xonchain1");
  assert.equal(h.calls.confirms, 1, "both callers must observe ONE registration");
});

test("a feed that already carries the id short-circuits with no chain work", async () => {
  const h = harness();

  const r = await registerSeriesExactlyOnce({ ...PARAMS, feedOnChainEventId: "0xexisting" }, h.deps);

  assert.deepEqual(r, { status: "already", onChainEventId: "0xexisting" });
  assert.equal(h.calls.broadcasts, 0);
  assert.equal(h.calls.confirms, 0);
});

test("in-flight entry is released after failure, so a later retry can proceed", async () => {
  let fail = true;
  const h = harness({
    registerEventOnChain: (async () => {
      if (fail) throw new Error("gas estimation reverted");
      return { onChainEventId: "0xonchain1", txHash: "0xtx1" };
    }) as RegisterDeps["registerEventOnChain"],
  });

  await assert.rejects(registerSeriesExactlyOnce(PARAMS, h.deps), /gas estimation/);
  assert.equal(h.pending.size, 0, "a tx that never broadcast leaves no marker");

  fail = false;
  const r = await registerSeriesExactlyOnce(PARAMS, h.deps);
  assert.equal(r.status, "registered");
});
