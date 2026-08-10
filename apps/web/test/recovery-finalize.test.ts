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
  type RecoveryFinalizeDeps,
} from "../src/lib/auth/recovery-finalize.js";

const PRESERVED = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const PRF_EOA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PRF_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111";
const POD_SEED = "seed-restored-from-escrow";
const FEED_KEY = "0x2222222222222222222222222222222222222222222222222222222222222222";

type BackfillArgs = {
  passkeyPrivKey: string;
  preservedKernelAddress: string;
  podSeed: string;
  feedSignerPrivKey?: string;
};

/** Happy-path deps for a passkey recovery, with call recording. */
function deps(over: Partial<RecoveryFinalizeDeps> = {}) {
  const calls: string[] = [];
  const backfillArgs: BackfillArgs[] = [];
  const d: RecoveryFinalizeDeps = {
    kind: () => "passkey",
    ensureSession: async () => {
      calls.push("ensureSession");
      return true;
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

test("passkey happy path: session first, then the envelope for the PRESERVED Kernel", async () => {
  const { d, calls, backfillArgs } = deps();
  const r = await finalizeRecovery(d);
  assert.deepEqual(r, { status: "portable", action: "wrote" });
  // Order is the property: the SOC upload is authenticated, so a backfill
  // before the mint could only fail.
  assert.deepEqual(calls, ["ensureSession", "backfill"]);
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
  const r = await finalizeRecovery(d);
  assert.equal(r.status, "failed");
  assert.match((r as { reason: string }).reason, /unreadable/);
});

test("a throwing backfill surfaces as failed, never as an unhandled throw", async () => {
  const { d } = deps({
    backfill: async () => {
      throw new Error("probe was inconclusive");
    },
  });
  const r = await finalizeRecovery(d);
  assert.equal(r.status, "failed");
  assert.match((r as { reason: string }).reason, /inconclusive/);
});

test("passkey with a failed session mint fails BEFORE the envelope write", async () => {
  const { d, calls } = deps({ ensureSession: async () => false });
  const r = await finalizeRecovery(d);
  assert.equal(r.status, "failed");
  assert.match((r as { reason: string }).reason, /session/);
  assert.ok(!calls.includes("backfill"), "must not attempt an authenticated write with no session");
});

test("no recovery binding on this device fails — nothing to point the envelope at", async () => {
  const { d, calls } = deps({ recoveryKernelFor: async () => undefined });
  const r = await finalizeRecovery(d);
  assert.equal(r.status, "failed");
  assert.match((r as { reason: string }).reason, /binding/);
  assert.ok(!calls.includes("backfill"));
});

test("a FAILED binding read reaches the caller as failure, not as 'no binding is fine'", async () => {
  const { d, calls } = deps({
    recoveryKernelFor: async () => {
      throw new Error("indexeddb unavailable");
    },
  });
  const r = await finalizeRecovery(d);
  assert.equal(r.status, "failed");
  assert.ok(!calls.includes("backfill"));
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
  const r = await finalizeRecovery(d);
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
  assert.deepEqual(r, { status: "session-only" });
  assert.deepEqual(calls, ["ensureSession"]);
});

test("a web3auth mint failure is STILL session-only — best-effort, the first action re-mints", async () => {
  const { d } = deps({ kind: () => "web3auth", ensureSession: async () => false });
  const r = await finalizeRecovery(d);
  assert.deepEqual(r, { status: "session-only" });
});
