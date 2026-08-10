/**
 * The background portability-envelope re-probe (#245 fix 4).
 *
 * Every test names the property it pins. The properties are the ones the incident
 * and #138 proved load-bearing:
 *
 *  - a failed read is never a verdict, in EITHER direction, and never spends an
 *    attempt;
 *  - the expensive Swarm probe never runs unless the cheap chain read says the
 *    cached parent is undeployed;
 *  - the heal is authorised by the CHAIN, never by the blob;
 *  - this path can only ever DELETE a `woco:kaddr:` entry — the negative that
 *    poisoned the device in the first place is never re-asserted from here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reprobeEnvelope,
  _resetInFlightForTests,
  type EnvelopeReprobeDeps,
  type ReprobeStorage,
} from "../src/lib/auth/envelope-reprobe.js";
import type { PortabilityRead } from "../src/lib/auth/recovery-portability.js";

const EOA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PHANTOM = "0xcccccccccccccccccccccccccccccccccccccccc";
const PRESERVED = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PRF_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111";
const STATE_KEY = `woco:kreprobe:passkey:${EOA}`;
const DAY = 86_400_000;

function memStore(seed: Record<string, string> = {}): ReprobeStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const FOUND: PortabilityRead = {
  status: "found",
  value: { preservedKernelAddress: PRESERVED, podSeed: "seed", feedSignerPrivKey: "0xfeed" },
};

/** Deps for a poisoned device: the cached parent is undeployed, an envelope exists. */
function deps(over: Partial<EnvelopeReprobeDeps> = {}, store = memStore()) {
  const calls: string[] = [];
  const bindings: Array<[string, string]> = [];
  const cleared: string[] = [];
  const notices: string[] = [];
  const base: EnvelopeReprobeDeps = {
    readKernelOwner: async (addr) => (addr === PRESERVED ? EOA : null),
    readEnvelope: async () => FOUND,
    putRecoveryBinding: async (pod, kernel) => void bindings.push([pod, kernel]),
    clearCachedKernelAddress: (_kind, eoa) => void cleared.push(eoa),
    isStillSignedInAs: () => true,
    logout: async () => {},
    postNotice: (m) => void notices.push(m),
    now: () => 1_000 * DAY,
    storage: store,
    online: () => true,
    ...over,
  };
  // Recording wraps the FINAL implementations, so an override still shows up in
  // the call order — the order is half of what these tests pin.
  const d: EnvelopeReprobeDeps = {
    ...base,
    readKernelOwner: async (addr) => {
      calls.push(`owner:${addr}`);
      return base.readKernelOwner(addr);
    },
    readEnvelope: async (key) => {
      calls.push("envelope");
      return base.readEnvelope(key);
    },
    logout: async () => {
      calls.push("logout");
      return base.logout();
    },
  };
  return { d, store, calls, bindings, cleared, notices };
}

const args = { kind: "passkey" as const, eoa: EOA, cachedParent: PHANTOM, passkeyPrivKey: PRF_KEY };

test.beforeEach(() => _resetInFlightForTests());

test("heals: envelope found + chain confirms ownership → binding written, cache dropped, signed out", async () => {
  const { d, calls, bindings, cleared, notices, store } = deps();
  const r = await reprobeEnvelope(args, d);

  assert.deepEqual(r, { status: "healed", preserved: PRESERVED, signedOut: true });
  assert.deepEqual(bindings, [[EOA, PRESERVED]], "the binding IS the heal");
  assert.deepEqual(cleared, [EOA], "the poisoned kaddr entry is removed");
  assert.equal(notices.length, 1, "the forced sign-out is explained, not silent");
  // Binding before the cache drop before the logout: every prefix leaves the
  // device correct or retrying.
  assert.deepEqual(calls, [`owner:${PHANTOM}`, "envelope", `owner:${PRESERVED}`, "logout"]);
  assert.equal(store.map.get(STATE_KEY), undefined, "throttle state is retired on a heal");
});

test("the blob is not authority: a preserved Kernel owned by someone else is NOT applied", async () => {
  const { d, bindings, cleared } = deps({
    readKernelOwner: async (addr) => (addr === PRESERVED ? "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" : null),
  });
  const r = await reprobeEnvelope(args, d);

  assert.equal(r.status, "inconclusive");
  assert.deepEqual(bindings, [], "no binding from an envelope the chain does not back");
  assert.deepEqual(cleared, [], "and nothing is dropped on the strength of it");
});

test("a failed owner read on the preserved Kernel refuses too — it is not a verdict", async () => {
  const { d, bindings } = deps({
    readKernelOwner: async (addr) => (addr === PRESERVED ? "error" : null),
  });
  const r = await reprobeEnvelope(args, d);
  assert.equal(r.status, "inconclusive");
  assert.deepEqual(bindings, []);
});

test("deployed + owned by this credential is terminal: no Swarm probe, now or ever", async () => {
  const store = memStore();
  const { d, calls } = deps({ readKernelOwner: async () => EOA }, store);
  const first = await reprobeEnvelope(args, d);
  assert.deepEqual(first, { status: "confirmed" });
  assert.deepEqual(calls, [`owner:${PHANTOM}`], "the cheap gate stopped it before Swarm");

  // A much later login must still skip — and the confirmation is bound to the
  // address it confirms, so it cannot be inherited by a different parent.
  _resetInFlightForTests();
  const { d: d2, calls: calls2 } = deps({ readKernelOwner: async () => EOA, now: () => 2_000 * DAY }, store);
  assert.deepEqual(await reprobeEnvelope(args, d2), { status: "skipped", reason: "confirmed" });
  assert.deepEqual(calls2, [], "terminal means zero network");

  _resetInFlightForTests();
  const { d: d3 } = deps({ readKernelOwner: async () => EOA, now: () => 2_000 * DAY }, store);
  const other = await reprobeEnvelope({ ...args, cachedParent: PRESERVED }, d3);
  assert.notEqual(other.status, "skipped", "a confirmation for one parent is not one for another");
});

test("a chain read that failed spends nothing — an RPC blip must not burn the ladder", async () => {
  const store = memStore();
  const { d, calls } = deps({ readKernelOwner: async () => "error" }, store);
  const r = await reprobeEnvelope(args, d);

  assert.deepEqual(r, { status: "inconclusive", reason: "owner read failed" });
  assert.deepEqual(calls, [`owner:${PHANTOM}`], "no Swarm probe off an unanswered question");
  assert.equal(store.map.get(STATE_KEY), undefined, "no attempt recorded, no cooldown started");
});

test("an orphaned credential is reported, never acted on (#255 owns the fix)", async () => {
  const other = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  const { d, bindings, cleared, calls } = deps({ readKernelOwner: async () => other });
  const r = await reprobeEnvelope(args, d);

  assert.deepEqual(r, { status: "orphaned", owner: other });
  assert.deepEqual(bindings, [], "clearing state here walks the user into #255's fallthrough");
  assert.deepEqual(cleared, []);
  assert.deepEqual(calls, [`owner:${PHANTOM}`]);
});

test("throttle: a second login inside the cooldown does nothing at all", async () => {
  const store = memStore();
  const { d } = deps({ readEnvelope: async () => ({ status: "absent" }) }, store);
  assert.deepEqual(await reprobeEnvelope(args, d), { status: "clear", reason: "no envelope" });

  _resetInFlightForTests();
  const { d: d2, calls } = deps(
    { readEnvelope: async () => ({ status: "absent" }), now: () => 1_000 * DAY + 60_000 },
    store,
  );
  assert.deepEqual(await reprobeEnvelope(args, d2), { status: "skipped", reason: "throttled" });
  assert.deepEqual(calls, [], "throttled means zero network, not a cheaper probe");
});

test("the ladder is finite: five verdicts and it stops for good", async () => {
  const store = memStore();
  let t = 1_000 * DAY;
  const seen: string[] = [];
  for (let i = 0; i < 7; i++) {
    _resetInFlightForTests();
    const { d } = deps(
      { readEnvelope: async () => ({ status: "absent" }), now: () => t },
      store,
    );
    seen.push((await reprobeEnvelope(args, d)).status);
    t += 30 * DAY; // always past the longest cooldown
  }
  assert.deepEqual(seen, ["clear", "clear", "clear", "clear", "clear", "skipped", "skipped"]);
});

test("an inconclusive Swarm read spends an attempt but asserts nothing", async () => {
  const store = memStore();
  const { d, bindings, cleared } = deps(
    { readEnvelope: async () => ({ status: "unreadable", reason: "gateway 503" }) },
    store,
  );
  const r = await reprobeEnvelope(args, d);

  assert.deepEqual(r, { status: "inconclusive", reason: "gateway 503" });
  assert.deepEqual(bindings, []);
  assert.deepEqual(cleared, [], "'could not tell' is not 'nothing is there'");
  assert.equal(JSON.parse(store.map.get(STATE_KEY)!).n, 1, "but the bee is still protected");
});

test("a throwing envelope read is contained, not propagated", async () => {
  const { d } = deps({
    readEnvelope: async () => {
      throw new Error("boom");
    },
  });
  const r = await reprobeEnvelope(args, d);
  assert.equal(r.status, "inconclusive");
});

test("offline skips before spending an attempt", async () => {
  const store = memStore();
  const { d, calls } = deps({ online: () => false }, store);
  assert.deepEqual(await reprobeEnvelope(args, d), { status: "skipped", reason: "offline" });
  assert.deepEqual(calls, []);
  assert.equal(store.map.get(STATE_KEY), undefined);
});

test("a clock that moved backwards re-anchors instead of probing on every login", async () => {
  const store = memStore({ [STATE_KEY]: JSON.stringify({ n: 1, at: 2_000 * DAY }) });
  const { d, calls } = deps({}, store);
  assert.deepEqual(await reprobeEnvelope(args, d), { status: "skipped", reason: "throttled" });
  assert.deepEqual(calls, []);
  assert.equal(JSON.parse(store.map.get(STATE_KEY)!).at, 1_000 * DAY, "cooldown restarts from now");
});

test("a corrupt throttle record costs a probe, never correctness", async () => {
  const store = memStore({ [STATE_KEY]: "not json" });
  const { d, bindings } = deps({}, store);
  assert.equal((await reprobeEnvelope(args, d)).status, "healed");
  assert.deepEqual(bindings, [[EOA, PRESERVED]]);
});

test("concurrent probes for the same credential collapse to one", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const { d } = deps({
    readEnvelope: async () => {
      await gate;
      return FOUND;
    },
  });
  const first = reprobeEnvelope(args, d);
  const second = await reprobeEnvelope(args, d);
  assert.deepEqual(second, { status: "skipped", reason: "in-flight" });
  release();
  assert.equal((await first).status, "healed");
});

test("a user who left mid-probe still gets the binding, but no forced sign-out", async () => {
  const { d, bindings, notices, calls } = deps({ isStillSignedInAs: () => false });
  const r = await reprobeEnvelope(args, d);

  assert.deepEqual(r, { status: "healed", preserved: PRESERVED, signedOut: false });
  assert.deepEqual(bindings, [[EOA, PRESERVED]], "the repair is durable either way");
  assert.deepEqual(notices, []);
  assert.ok(!calls.includes("logout"));
});
