/**
 * The auto-find walk (#157): chain-confirmed, oldest first, tri-state honest.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { GUARDIAN_ACCOUNT_INDEX_FORMAT, type GuardianAccountIndex } from "@woco/shared";
import { autoFindAccount } from "../src/lib/auth/recovery-autofind.js";

const K = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const index = (accounts: GuardianAccountIndex["accounts"]) => ({
  status: "found" as const,
  value: { format: GUARDIAN_ACCOUNT_INDEX_FORMAT, accounts },
  version: 0,
  scanClean: true,
});

test("the first candidate the chain confirms wins, oldest first, with its label", async () => {
  const asked: string[] = [];
  const out = await autoFindAccount({
    index: index([
      { kernelAddress: K(2), addedAt: 20, label: "second" },
      { kernelAddress: K(1), addedAt: 10, label: "first" },
    ]),
    isRegistered: async (k) => { asked.push(k); return true; },
  });
  assert.deepEqual(out, { status: "found", kernelAddress: K(1), label: "first" });
  assert.deepEqual(asked, [K(1)]);
});

test("an account that no longer lists this guardian on-chain is skipped (replaced backup)", async () => {
  const out = await autoFindAccount({
    index: index([
      { kernelAddress: K(1), addedAt: 10 },
      { kernelAddress: K(2), addedAt: 20 },
    ]),
    isRegistered: async (k) => k === K(2),
  });
  assert.deepEqual(out, { status: "found", kernelAddress: K(2) });
});

test("no candidate confirmed and the chain answered for all → none (manual entry)", async () => {
  const out = await autoFindAccount({
    index: index([{ kernelAddress: K(1), addedAt: 10 }]),
    isRegistered: async () => false,
  });
  assert.deepEqual(out, { status: "none" });
});

test("an absent index is none; an unreadable index is unavailable — never none", async () => {
  assert.deepEqual(await autoFindAccount({ index: { status: "absent" }, isRegistered: async () => true }), { status: "none" });
  const out = await autoFindAccount({ index: { status: "unavailable", reason: "gateway 503" }, isRegistered: async () => true });
  assert.equal(out.status, "unavailable");
});

test("a candidate the chain would not answer for makes the outcome unavailable, unless a later one is confirmed", async () => {
  const out = await autoFindAccount({
    index: index([
      { kernelAddress: K(1), addedAt: 10 },
      { kernelAddress: K(2), addedAt: 20 },
    ]),
    isRegistered: async (k) => (k === K(1) ? null : false),
  });
  assert.equal(out.status, "unavailable");
  const out2 = await autoFindAccount({
    index: index([
      { kernelAddress: K(1), addedAt: 10 },
      { kernelAddress: K(2), addedAt: 20 },
    ]),
    isRegistered: async (k) => (k === K(1) ? null : true),
  });
  assert.deepEqual(out2, { status: "found", kernelAddress: K(2) });
});

test("the walk is capped", async () => {
  let asked = 0;
  const out = await autoFindAccount({
    index: index(Array.from({ length: 20 }, (_, i) => ({ kernelAddress: K(i + 1), addedAt: i }))),
    isRegistered: async () => { asked++; return false; },
    maxCandidates: 3,
  });
  assert.equal(asked, 3);
  assert.deepEqual(out, { status: "none" });
});
