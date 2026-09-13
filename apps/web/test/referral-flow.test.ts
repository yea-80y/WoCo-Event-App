/**
 * The no-prompt settle (#476).
 *
 * Two properties are worth this file, and neither is visible from the call site:
 *
 *   1. WHAT SURVIVES. The capture is the only record that an invite was
 *      followed — the link is not followed twice — so clearing it on an outcome
 *      that could still succeed silently loses someone's credit. Three outcomes
 *      keep it and three do not, and the difference is a single `clear()` call
 *      in each branch.
 *   2. NO PROMPT, EVER. The statement is written at a moment the user did not
 *      ask to sign anything, so the signer may only come from the prompt-free
 *      getter. `getSigner` returning null must end the attempt, not fall back.
 *
 * MUTATION: move `deps.clear()` above the `superseded` check and "a superseded
 * write keeps the capture" goes red; drop the `if (!signer) return` and the
 * signer-source test goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Hex0x } from "@woco/shared";
import type { VerifiedWriteResult } from "../src/lib/swarm/verified-write.js";
import { settleCapturedReferral } from "../src/lib/campaign/referral-flow.js";

const REFERRER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex0x;
const ME = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex0x;
const SIGNER = { privKey: `0x${"11".repeat(32)}`, address: "0xcccccccccccccccccccccccccccccccccccccccc" };

type Harness = {
  cleared: number;
  writes: Array<{ signer: { address: string }; referrer: Hex0x }>;
  signerCalls: number;
};

function harness(opts: {
  ref?: Hex0x | null;
  parent?: string | null;
  signer?: { privKey: string; address: string } | null;
  write?: () => Promise<VerifiedWriteResult>;
}) {
  const state: Harness = { cleared: 0, writes: [], signerCalls: 0 };
  const deps = {
    parent: opts.parent ?? ME,
    capturedRef: () => opts.ref ?? null,
    getSigner: async () => {
      state.signerCalls++;
      return opts.signer === undefined ? SIGNER : opts.signer;
    },
    write: async (signer: { privKey: string; address: string }, referrer: Hex0x) => {
      state.writes.push({ signer, referrer });
      return opts.write
        ? await opts.write()
        : ({ status: "verified", version: 0 } as VerifiedWriteResult);
    },
    clear: () => { state.cleared++; },
  };
  return { deps, state };
}

test("no capture — nothing happens and nothing is cleared", async () => {
  const { deps, state } = harness({ ref: null });
  assert.equal(await settleCapturedReferral(deps), "none");
  assert.equal(state.cleared, 0);
  assert.equal(state.signerCalls, 0, "a missing capture must not even reach for a signer");
});

test("a self-referral is dropped, not retried forever", async () => {
  // Capital-letter parent on purpose: the capture is stored lowercased and the
  // signed-in address is not, so a case-sensitive compare would let a user
  // refer themselves past this check.
  const { deps, state } = harness({ ref: ME, parent: ME.toUpperCase() });
  assert.equal(await settleCapturedReferral(deps), "self");
  assert.equal(state.cleared, 1);
  assert.equal(state.writes.length, 0);
});

test("no seed on this device — the capture waits, and nothing was prompted", async () => {
  const { deps, state } = harness({ ref: REFERRER, signer: null });
  assert.equal(await settleCapturedReferral(deps), "no-signer");
  assert.equal(state.cleared, 0, "the invite must survive to the next authenticated visit");
});

test("a VERIFIED statement clears the capture", async () => {
  const { deps, state } = harness({
    ref: REFERRER,
    write: async () => ({ status: "verified", version: 3 }),
  });
  assert.equal(await settleCapturedReferral(deps), "written");
  assert.equal(state.cleared, 1);
  assert.deepEqual(state.writes[0]?.referrer, REFERRER);
  assert.equal(state.writes[0]?.signer.address, SIGNER.address);
});

test("an UNCONFIRMED write keeps the capture — accepted is not on the feed", async () => {
  // The read-back could not answer. Usually propagation; also exactly the shape
  // a dead postage batch takes, and in that case clearing would lose the
  // referral silently. The retry is idempotent, so keeping it is cheap.
  const { deps, state } = harness({
    ref: REFERRER,
    write: async () => ({ status: "unconfirmed", version: 3, reason: "read-back timed out" }),
  });
  assert.equal(await settleCapturedReferral(deps), "deferred");
  assert.equal(state.cleared, 0);
});

test("a superseded write keeps the capture — the write is LOST, not late", async () => {
  const { deps, state } = harness({
    ref: REFERRER,
    write: async () => ({ status: "superseded", version: 3 }),
  });
  assert.equal(await settleCapturedReferral(deps), "deferred");
  assert.equal(state.cleared, 0);
});

test("a thrown write keeps the capture — a network failure is not a decision", async () => {
  const { deps, state } = harness({
    ref: REFERRER,
    write: async () => { throw new Error("gateway down"); },
  });
  assert.equal(await settleCapturedReferral(deps), "failed");
  assert.equal(state.cleared, 0);
});

test("the signer getter is the ONLY signer source", async () => {
  // The guarantee is not "it usually has a signer" — it is that a device with
  // no seed writes NOTHING and is asked for NOTHING. A fallback to any other
  // key would be a ceremony the user did not request, at a moment they were
  // doing something else.
  const { deps, state } = harness({ ref: REFERRER, signer: null });
  await settleCapturedReferral(deps);
  assert.equal(state.writes.length, 0, "no signer must mean no write");
  assert.equal(state.signerCalls, 1, "and exactly one attempt to get one");
});
