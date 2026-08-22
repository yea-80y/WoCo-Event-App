/**
 * The post-recovery finalize step (#245 fix 2).
 *
 * Every test names the property it pins, and asserts the REASON as well as the
 * status where the reason is the point. The properties are the ones the incident
 * proved load-bearing: the session must exist before the envelope write, an
 * inconclusive write is a failure (never a silent success), and the envelope is
 * written for the PRESERVED Kernel — not anything derived from the credential.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  finalizeRecovery,
  gatherBackfillArgs,
  type RecoveryFinalizeDeps,
} from "../src/lib/auth/recovery-finalize.js";
// The REAL payload type (#260): a local copy here would let the test's
// deepEqual keep pinning a shape production no longer sends.
import type { PortabilityBackfillArgs } from "../src/lib/auth/recovery-portability.js";

const PRESERVED = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const PRF_EOA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PRF_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111";
const POD_SEED = "seed-restored-from-escrow";
const FEED_KEY = "0x2222222222222222222222222222222222222222222222222222222222222222";

/** Happy-path deps for a passkey recovery, with call recording. */
function deps(over: Partial<RecoveryFinalizeDeps> = {}) {
  const calls: string[] = [];
  const backfillArgs: PortabilityBackfillArgs[] = [];
  const d: RecoveryFinalizeDeps = {
    kind: () => "passkey",
    ensureSession: async () => {
      calls.push("ensureSession");
      return true;
    },
    probeSession: async () => {
      calls.push("probeSession");
      return { ok: true };
    },
    getPasskeyPrivKey: () => PRF_KEY,
    getPodAddress: () => PRF_EOA,
    recoveryKernelFor: async (pod) => (pod === PRF_EOA ? PRESERVED : undefined),
    restorePodSeed: async () => POD_SEED,
    getContentFeedSigner: async () => ({ privKey: FEED_KEY }),
    backfill: async (args) => {
      calls.push("backfill");
      backfillArgs.push(args);
      return { action: "wrote", reason: "absent" };
    },
    ...over,
  };
  return { d, calls, backfillArgs };
}

test("passkey happy path: session first, then the server probe, then the envelope for the PRESERVED Kernel", async () => {
  const { d, calls, backfillArgs } = deps();
  const r = await finalizeRecovery(d);
  assert.deepEqual(r, { status: "portable", action: "wrote" });
  // Order is the property: the SOC upload is authenticated, so a backfill
  // before the mint could only fail; and the server must hear from the new key
  // before any step that can fail for its own reasons (#200).
  assert.deepEqual(calls, ["ensureSession", "probeSession", "backfill"]);
  // The envelope must carry the preserved address + escrow-restored secrets —
  // resolving from the credential instead is the #245 defect itself.
  assert.deepEqual(backfillArgs, [
    {
      passkeyPrivKey: PRF_KEY,
      preservedKernelAddress: PRESERVED,
      podSeed: POD_SEED,
      feedSignerPrivKey: FEED_KEY,
    },
  ]);
});

test("#260: the gather helper is the ONE owner of the preamble — payload pinned at the source", async () => {
  // finalizeRecovery and auth-store's mint-time backfill both feed from this,
  // so a field added to the payload changes exactly one gatherer — the
  // ping-pong drift (#153 class) has nowhere to start.
  const { d } = deps();
  const g = await gatherBackfillArgs(d);
  assert.deepEqual(g, {
    status: "ready",
    args: {
      passkeyPrivKey: PRF_KEY,
      preservedKernelAddress: PRESERVED,
      podSeed: POD_SEED,
      feedSignerPrivKey: FEED_KEY,
    },
  });
});

test("an already-current envelope is success, not a retry loop", async () => {
  const { d } = deps({
    backfill: async () => ({ action: "skipped", reason: "envelope already current" }),
  });
  const r = await finalizeRecovery(d);
  assert.deepEqual(r, { status: "portable", action: "skipped" });
});

test("a deferred backfill is a FAILURE — the envelope is not verifiably there", async () => {
  const { d } = deps({
    backfill: async () => ({ action: "deferred", reason: "envelope chunk unreadable" }),
  });
  const r = await finalizeRecovery(d, { attempts: 1 });
  assert.equal(r.status, "failed");
  assert.match((r as { reason: string }).reason, /unreadable/);
  // Transient by construction — the retry re-reads and skips cleanly.
  assert.equal((r as { retryable: boolean }).retryable, true);
});

test("the DETERMINISTIC feed-signer guard is reported as NOT retryable", async () => {
  // An account whose escrow carried no feed signer re-throws this identically on
  // every call. Calling it retryable is an infinite loop with encouraging copy.
  const { d } = deps({
    getContentFeedSigner: async () => {
      throw new Error(
        "Recovered account feed signer unavailable — restore from recovery escrow required; refusing to derive a divergent key.",
      );
    },
  });
  const r = await finalizeRecovery(d);
  assert.equal(r.status, "failed");
  assert.equal((r as { retryable: boolean }).retryable, false);
});

test("a transient feed-signer fault stays retryable — only the guard is terminal", async () => {
  const { d } = deps({
    getContentFeedSigner: async () => {
      throw new Error("decrypt failed");
    },
  });
  const r = await finalizeRecovery(d, { attempts: 1 });
  assert.equal(r.status, "failed");
  assert.equal((r as { retryable: boolean }).retryable, true);
});

test("expectPasskey refuses when the store's kind was torn down mid-recovery", async () => {
  // A Sign out while parked on the warning screen would otherwise route a passkey
  // retry down the web3auth branch and render success with no envelope written.
  const { d, calls } = deps({ kind: () => "none" });
  const r = await finalizeRecovery(d, { expectPasskey: true });
  assert.equal(r.status, "failed");
  assert.equal((r as { retryable: boolean }).retryable, false);
  assert.match((r as { reason: string }).reason, /auth state changed/);
  assert.deepEqual(calls, [], "must not mint or write against a torn-down store");
});

test("expectPasskey is satisfied by a passkey store — the happy path is unaffected", async () => {
  const { d } = deps();
  const r = await finalizeRecovery(d, { expectPasskey: true });
  assert.equal(r.status, "portable");
});

test("an email recovery still finalizes normally when expectPasskey is false", async () => {
  const { d } = deps({ kind: () => "web3auth" });
  const r = await finalizeRecovery(d, { expectPasskey: false });
  assert.deepEqual(r, { status: "session-only", sessionMinted: true });
});

test("a throwing backfill surfaces as failed, never as an unhandled throw", async () => {
  const { d } = deps({
    backfill: async () => {
      throw new Error("probe was inconclusive");
    },
  });
  const r = await finalizeRecovery(d, { attempts: 1 });
  assert.equal(r.status, "failed");
  assert.match((r as { reason: string }).reason, /inconclusive/);
});

test("passkey with a failed session mint fails BEFORE the envelope write", async () => {
  const { d, calls } = deps({ ensureSession: async () => false });
  const r = await finalizeRecovery(d, { attempts: 1 });
  assert.equal(r.status, "failed");
  assert.match((r as { reason: string }).reason, /session/);
  assert.equal((r as { stage: string }).stage, "session");
  assert.ok(!calls.includes("backfill"), "must not attempt an authenticated write with no session");
  assert.ok(!calls.includes("probeSession"), "nothing to probe with — no session");
});

test("no recovery binding on this device fails — nothing to point the envelope at", async () => {
  const { d, calls } = deps({ recoveryKernelFor: async () => undefined });
  const r = await finalizeRecovery(d);
  assert.equal(r.status, "failed");
  assert.match((r as { reason: string }).reason, /binding/);
  assert.ok(!calls.includes("backfill"));
});

test("a FAILED binding read says it FAILED — never 'no binding on this device'", async () => {
  // The binding is written first (#230), so "absent" after a successful ceremony
  // points debugging at the commit; a read fault must not assert that.
  const { d, calls } = deps({
    recoveryKernelFor: async () => {
      throw new Error("indexeddb unavailable");
    },
  });
  const r = await finalizeRecovery(d, { attempts: 1 });
  assert.equal(r.status, "failed");
  assert.match((r as { reason: string }).reason, /binding read failed/);
  assert.equal((r as { retryable: boolean }).retryable, true);
  assert.ok(!calls.includes("backfill"));
});

test("a FAILED seed read is distinguished from a genuinely absent seed", async () => {
  const { d } = deps({
    restorePodSeed: async () => {
      throw new Error("indexeddb unavailable");
    },
  });
  const r = await finalizeRecovery(d, { attempts: 1 });
  assert.match((r as { reason: string }).reason, /seed read failed/);
  assert.equal((r as { retryable: boolean }).retryable, true);

  const { d: d2 } = deps({ restorePodSeed: async () => null });
  const r2 = await finalizeRecovery(d2);
  assert.match((r2 as { reason: string }).reason, /seed absent/);
  assert.equal((r2 as { retryable: boolean }).retryable, false);
});

test("an unreadable POD seed fails — the envelope must carry the escrow-restored seed", async () => {
  const { d, calls } = deps({ restorePodSeed: async () => null });
  const r = await finalizeRecovery(d);
  assert.equal(r.status, "failed");
  assert.match((r as { reason: string }).reason, /seed/i);
  assert.ok(!calls.includes("backfill"));
});

test("a feed-signer read THROW fails the step — never write a signer-stripped envelope", async () => {
  const { d, calls } = deps({
    getContentFeedSigner: async () => {
      throw new Error("decrypt failed");
    },
  });
  const r = await finalizeRecovery(d, { attempts: 1 });
  assert.equal(r.status, "failed");
  assert.match((r as { reason: string }).reason, /feed signer/);
  assert.ok(!calls.includes("backfill"));
});

test("a genuinely absent feed signer proceeds, envelope simply carries none", async () => {
  const { d, backfillArgs } = deps({ getContentFeedSigner: async () => null });
  const r = await finalizeRecovery(d);
  assert.equal(r.status, "portable");
  assert.equal(backfillArgs[0]?.feedSignerPrivKey, undefined);
});

test("a web3auth owner is session-only: no envelope, and the write path is never touched", async () => {
  const { d, calls } = deps({ kind: () => "web3auth" });
  const r = await finalizeRecovery(d);
  assert.deepEqual(r, { status: "session-only", sessionMinted: true });
  assert.deepEqual(calls, ["ensureSession", "probeSession"]);
});

test("a web3auth mint failure stays session-only but REPORTS the missing session", async () => {
  // Best-effort by design, but the caller must not render unqualified success:
  // the user's next action would ask them to sign in, reading as "it didn't work".
  const { d } = deps({ kind: () => "web3auth", ensureSession: async () => false });
  const r = await finalizeRecovery(d);
  assert.deepEqual(r, { status: "session-only", sessionMinted: false });
});

test("#273: a transient failure is retried silently into success", async () => {
  // The live observation this pins: the user's SECOND manual click succeeded,
  // so the machine clicks for them before any warning renders.
  let writes = 0;
  const slept: number[] = [];
  const retries: string[] = [];
  const { d } = deps({
    backfill: async () => {
      writes++;
      if (writes === 1) return { action: "deferred", reason: "version probe inconclusive" };
      return { action: "wrote", reason: "absent" };
    },
  });
  const r = await finalizeRecovery(d, {
    onRetry: (attempt, reason) => retries.push(`${attempt}:${reason}`),
    _sleep: async (ms) => {
      slept.push(ms);
    },
  });
  assert.deepEqual(r, { status: "portable", action: "wrote" });
  assert.equal(writes, 2, "second attempt ran without user input");
  assert.deepEqual(slept, [1500], "one backoff before the silent retry");
  assert.deepEqual(retries, ["2:version probe inconclusive"], "the UI is told, with the reason");
});

test("#273: retries stop at the cap and surface the LAST failure", async () => {
  let writes = 0;
  const slept: number[] = [];
  const { d } = deps({
    backfill: async () => {
      writes++;
      return { action: "deferred", reason: `attempt ${writes} inconclusive` };
    },
  });
  const r = await finalizeRecovery(d, {
    _sleep: async (ms) => {
      slept.push(ms);
    },
  });
  assert.equal(r.status, "failed");
  assert.match((r as { reason: string }).reason, /attempt 3/);
  assert.equal(writes, 3, "default cap is three total attempts");
  assert.deepEqual(slept, [1500, 3000], "backoff doubles between attempts");
});

test("#273: a NON-retryable failure is never retried — the guard would loop identically", async () => {
  let reads = 0;
  const slept: number[] = [];
  const { d } = deps({
    getContentFeedSigner: async () => {
      reads++;
      throw new Error(
        "Recovered account feed signer unavailable — restore from recovery escrow required; refusing to derive a divergent key.",
      );
    },
  });
  const r = await finalizeRecovery(d, {
    _sleep: async (ms) => {
      slept.push(ms);
    },
  });
  assert.equal(r.status, "failed");
  assert.equal((r as { retryable: boolean }).retryable, false);
  assert.equal(reads, 1, "deterministic failure runs exactly once");
  assert.deepEqual(slept, [], "no backoff is ever taken");
});

test("#273: the WHOLE step re-runs on retry — session checked first each time", async () => {
  // The session could have died between attempts; each accessor is where its
  // own staleness is detected, so no sub-read is skipped on the retry.
  let writes = 0;
  const { d, calls } = deps({
    backfill: async () => {
      writes++;
      if (writes === 1) throw new Error("stamp timed out");
      return { action: "wrote", reason: "absent" };
    },
  });
  const r = await finalizeRecovery(d, { _sleep: async () => {} });
  assert.equal(r.status, "portable");
  assert.equal(writes, 2);
  assert.deepEqual(
    calls,
    ["ensureSession", "probeSession", "ensureSession", "probeSession"],
    "mint re-verified on every attempt",
  );
});

// ── #200: the server must hear from the new key before the user acts ─────────
//
// The server retires the rotated-out key on the rotated-in key's FIRST contact
// (a cached owner may confirm, never condemn — so the new key's rejection is
// re-read live). Passkey finalize always made that contact through the envelope
// upload; web3auth finalize did not, and a retired key coasted on the server's
// cached owner for up to the TTL. The probe makes the contact explicit for both.

test("#200: a web3auth owner probes the server — the one contact this kind makes before the user acts", async () => {
  const { d, calls } = deps({ kind: () => "web3auth" });
  const r = await finalizeRecovery(d);
  assert.deepEqual(r, { status: "session-only", sessionMinted: true });
  assert.ok(calls.includes("probeSession"), "no server contact — the retired key keeps coasting");
});

test("#200: a web3auth mint failure skips the probe — there is no session to probe with", async () => {
  const { d, calls } = deps({ kind: () => "web3auth", ensureSession: async () => false });
  const r = await finalizeRecovery(d);
  assert.deepEqual(r, { status: "session-only", sessionMinted: false });
  assert.ok(!calls.includes("probeSession"));
});

test("#200: a refused probe for web3auth reports no working session — 'You're back in' must not render unqualified", async () => {
  const { d } = deps({
    kind: () => "web3auth",
    probeSession: async () => ({ ok: false, reason: "Session has been revoked" }),
  });
  const r = await finalizeRecovery(d);
  assert.deepEqual(r, { status: "session-only", sessionMinted: false });
});

test("#200: a refused probe for passkey is a retryable session-stage failure, and no envelope is written", async () => {
  // The usual cause is a lagging RPC replica the server now discards (#200
  // server half); the next attempt heals it. Retryable, and the reason is kept.
  const { d, calls } = deps({
    probeSession: async () => ({ ok: false, reason: "Invalid signature" }),
  });
  const r = await finalizeRecovery(d, { attempts: 1 });
  assert.equal(r.status, "failed");
  assert.equal((r as { stage: string }).stage, "session");
  assert.equal((r as { retryable: boolean }).retryable, true);
  assert.match((r as { reason: string }).reason, /not accepted by the server: Invalid signature/);
  assert.ok(!calls.includes("backfill"), "must not write the envelope when the server refuses the session");
});

test("#200: the probe runs on every retry — a refusal on the first attempt is healed by the second", async () => {
  let probes = 0;
  const { d, calls } = deps({
    probeSession: async () => {
      probes++;
      calls.push("probeSession");
      return probes === 1 ? { ok: false, reason: "Invalid signature" } : { ok: true };
    },
  });
  const r = await finalizeRecovery(d, { _sleep: async () => {} });
  assert.deepEqual(r, { status: "portable", action: "wrote" });
  assert.equal(probes, 2);
  assert.deepEqual(calls, ["ensureSession", "probeSession", "ensureSession", "probeSession", "backfill"]);
});
