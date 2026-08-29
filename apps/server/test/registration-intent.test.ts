/**
 * The #318 broadcast-journal contract, end to end:
 *
 *  - an UNWRITABLE intent journal ABORTS the broadcast (the disk that fails
 *    this write is the disk that loses the marker in the crash that follows —
 *    and an unjournalled registerEvent is one a restart can duplicate);
 *  - a HASH-LESS marker (crash between the intent write and the hash upgrade)
 *    resolves through a proof ladder whose "re-send" answers are proven, never
 *    guessed — the walk failing REFUSES rather than reading as "absent".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventFeed } from "@woco/shared";
import {
  registerSeriesExactlyOnce,
  type RegisterDeps,
  type RegisterParams,
} from "../src/lib/event/register-once.js";
import {
  resolveRegistrationIntent,
  type IntentDeps,
} from "../src/lib/event/registration-intent.js";

// ── The ladder itself ────────────────────────────────────────────────────────

const MARKER = { nonce: 40 };
const REF = "0xmanifest";

function ladderDeps(over: Partial<IntentDeps>): IntentDeps {
  return {
    findByManifestRef: async () => null,
    getSponsorTxCounts: async () => ({ latest: 40, pendingCount: 40 }),
    ...over,
  };
}

test("a landed registration is ADOPTED — the manifest proof outranks every nonce inference", async () => {
  const r = await resolveRegistrationIntent(MARKER, REF, ladderDeps({
    findByManifestRef: async () => "0xonchain9",
    // Even a consumed-slot signal must not turn a landed registration into a re-send.
    getSponsorTxCounts: async () => ({ latest: 99, pendingCount: 99 }),
  }));
  assert.deepEqual(r, { status: "registered", onChainEventId: "0xonchain9" });
});

test("a failed chain walk REFUSES — it never reads as 'absent, safe to re-send'", async () => {
  await assert.rejects(
    resolveRegistrationIntent(MARKER, REF, ladderDeps({
      findByManifestRef: async () => { throw new Error("rpc down"); },
    })),
    /rpc down/,
  );
});

test("slot consumed + manifest absent → the tx can never mine → re-send is proven safe", async () => {
  const r = await resolveRegistrationIntent(MARKER, REF, ladderDeps({
    getSponsorTxCounts: async () => ({ latest: 41, pendingCount: 41 }),
  }));
  assert.deepEqual(r, { status: "resend" });
});

test("slot occupied in the visible mempool → refuse, come back", async () => {
  const r = await resolveRegistrationIntent(MARKER, REF, ladderDeps({
    getSponsorTxCounts: async () => ({ latest: 40, pendingCount: 41 }),
  }));
  assert.deepEqual(r, { status: "pending" });
});

test("slot untouched everywhere visible → the common crash-before-send → re-send", async () => {
  const r = await resolveRegistrationIntent(MARKER, REF, ladderDeps({}));
  assert.deepEqual(r, { status: "resend" });
});

// ── register-once integration ────────────────────────────────────────────────

const PARAMS: RegisterParams = {
  eventId: "evt-i",
  seriesId: "ser-i",
  supply: 10,
  manifestRef: "0xdef",
  v2Params: { organiser: "0xc", eventEndTs: 9_999_999_999, priceBaseUnits: 0n, payoutRecipient: "0xc", dropGate: "0x0" },
};
const FEED = { eventId: "evt-i" } as unknown as EventFeed;

function harness(over: Partial<RegisterDeps> = {}) {
  const registry = new Map<string, string>();
  const pending = new Map<string, { txHash?: string; nonce: number; chainId: number; at: string }>();
  const calls = { broadcasts: 0 };

  const deps: RegisterDeps = {
    lookupOnChainEventId: (e, s) => registry.get(`${e}|${s}`) ?? null,
    lookupPending: (e, s) => pending.get(`${e}|${s}`) ?? null,
    recordPending: (e, s, tx) => void pending.set(`${e}|${s}`, { ...tx, at: "now" }),
    recordIntent: (e, s, r) => void pending.set(`${e}|${s}`, { ...r, at: "now" }),
    clearPending: (e, s) => void pending.delete(`${e}|${s}`),
    resolveRegisterTx: async () => ({ status: "pending" as const, txHash: "0xtx" }) as never,
    resolveIntent: async () => ({ status: "pending" as const }),
    registerEventOnChain: (async (_s, _r, _v2, onTxSent, onTxReserved) => {
      onTxReserved?.({ nonce: 7, chainId: 421614 });
      calls.broadcasts++;
      onTxSent?.({ txHash: "0xtx1", nonce: 7, chainId: 421614 });
      return { onChainEventId: "0xonchain1", txHash: "0xtx1" };
    }) as RegisterDeps["registerEventOnChain"],
    confirmSeriesOnChain: (async (e, s, id) => {
      registry.set(`${e}|${s}`, id);
      return FEED;
    }) as RegisterDeps["confirmSeriesOnChain"],
    ...over,
  };
  return { deps, registry, pending, calls };
}

test("an unwritable intent journal aborts the whole registration — nothing is broadcast", async () => {
  const h = harness({
    recordIntent: () => {
      throw new Error("registration journal unwritable — refusing to broadcast registerEvent");
    },
  });
  await assert.rejects(
    registerSeriesExactlyOnce({ ...PARAMS, eventId: "evt-abort" }, h.deps),
    /journal unwritable/,
  );
  assert.equal(h.calls.broadcasts, 0, "the send must never happen unjournalled");
});

test("a hash-less marker that resolves 'registered' is adopted with no broadcast", async () => {
  const h = harness({
    resolveIntent: async () => ({ status: "registered" as const, onChainEventId: "0xrecovered" }),
  });
  h.pending.set("evt-i|ser-i", { nonce: 12, chainId: 421614, at: "then" });

  const r = await registerSeriesExactlyOnce(PARAMS, h.deps);

  assert.equal(r.status, "registered");
  assert.equal(r.status === "registered" && r.onChainEventId, "0xrecovered");
  assert.equal(h.calls.broadcasts, 0);
  assert.equal(h.pending.size, 0);
});

test("a hash-less marker that may be in flight refuses — no broadcast, marker kept", async () => {
  const h = harness();
  h.pending.set("evt-i|ser-i", { nonce: 12, chainId: 421614, at: "then" });

  const r = await registerSeriesExactlyOnce({ ...PARAMS, eventId: "evt-i", seriesId: "ser-i" }, h.deps);

  assert.equal(r.status, "pending");
  assert.equal(h.calls.broadcasts, 0);
  assert.equal(h.pending.size, 1, "an unresolved intent must stay journalled");
});

test("a proven-dead intent clears and a fresh broadcast completes the registration", async () => {
  const h = harness({ resolveIntent: async () => ({ status: "resend" as const }) });
  h.pending.set("evt-i|ser-i", { nonce: 12, chainId: 421614, at: "then" });

  const r = await registerSeriesExactlyOnce({ ...PARAMS, eventId: "evt-i", seriesId: "ser-i" }, h.deps);

  assert.equal(r.status, "registered");
  assert.equal(h.calls.broadcasts, 1);
  assert.equal(h.pending.size, 0);
});
