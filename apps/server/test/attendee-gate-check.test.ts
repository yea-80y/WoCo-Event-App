/**
 * The attendee gate rule (`lib/gate/check.ts`, #575): which facts unlock an
 * account, in what order, and what a read that cannot answer does.
 *
 * Pinned:
 *   - each of the four facts unlocks on its own and reports its own `via`;
 *   - an organiser keeps reporting "organiser" when Stripe is also complete —
 *     the client turns that word into the Studio link on a fresh device;
 *   - a ticket ends the walk before any slower read is made;
 *   - a Swarm hiccup on the events read falls THROUGH to the memory-backed
 *     branches instead of refusing an account they would unlock;
 *   - a referral read that could not answer, or threw, refuses — it is never
 *     "confirmed", and never a 500 on a profile save;
 *   - the kill-switch reports the real reason when there is one.
 *
 * MUTATION CHECK: delete any one branch, swap the Stripe and organiser
 * branches, or let the events read's rejection escape, and a test here goes red.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateDeps } from "../src/lib/gate/check.js";
import type { ReferralUnlock } from "../src/lib/gate/referral-unlock.js";

let checkAttendeeGate: typeof import("../src/lib/gate/check.js").checkAttendeeGate;

before(async () => {
  // Modules pulled in transitively capture `join(process.cwd(), ".data")` at load.
  process.chdir(mkdtempSync(join(tmpdir(), "woco-gate-check-")));
  ({ checkAttendeeGate } = await import("../src/lib/gate/check.js"));
});

const PARENT = "0xAbCd000000000000000000000000000000000001";
const LOWER = PARENT.toLowerCase();

interface Facts {
  bindings?: number;
  /** An Error makes the read reject, as a bee fault does. */
  events?: unknown[] | Error;
  stripe?: boolean;
  /** An Error makes the read reject — which the live reader never does, and the gate must survive anyway. */
  referral?: ReferralUnlock | Error;
  enforced?: boolean;
}

function facts(f: Facts = {}) {
  const calls: string[] = [];
  const seen: string[] = [];
  const deps: GateDeps = {
    bindingCount: (p) => { calls.push("bindings"); seen.push(p); return f.bindings ?? 0; },
    creatorEvents: async (p) => {
      calls.push("events"); seen.push(p);
      if (f.events instanceof Error) throw f.events;
      return f.events ?? [];
    },
    stripeVerified: (p) => { calls.push("stripe"); seen.push(p); return f.stripe ?? false; },
    referralUnlock: async (p) => {
      calls.push("referral"); seen.push(p);
      if (f.referral instanceof Error) throw f.referral;
      return f.referral ?? "none";
    },
    enforced: () => f.enforced ?? true,
  };
  return { deps, calls, seen };
}

test("nothing unlocks: every fact is consulted, in cost order, and the answer is not gated", async () => {
  const { deps, calls } = facts();
  assert.deepEqual(await checkAttendeeGate(PARENT, deps), { gated: false });
  assert.deepEqual(calls, ["bindings", "events", "stripe", "referral"]);
});

test("a ticket binding unlocks, and nothing slower is read", async () => {
  const { deps, calls } = facts({ bindings: 1, events: [{}], stripe: true, referral: "confirmed" });
  assert.deepEqual(await checkAttendeeGate(PARENT, deps), { gated: true, via: "ticket" });
  assert.deepEqual(calls, ["bindings"]);
});

test("published events unlock as an organiser", async () => {
  const { deps } = facts({ events: [{}] });
  assert.deepEqual(await checkAttendeeGate(PARENT, deps), { gated: true, via: "organiser" });
});

test("completed Stripe verification unlocks as stripe; an incomplete record does not", async () => {
  const { deps } = facts({ stripe: true });
  assert.deepEqual(await checkAttendeeGate(PARENT, deps), { gated: true, via: "stripe" });
  const { deps: not } = facts({ stripe: false });
  assert.deepEqual(await checkAttendeeGate(PARENT, not), { gated: false });
});

test("a confirmed referral unlocks as referral; none does not", async () => {
  const { deps } = facts({ referral: "confirmed" });
  assert.deepEqual(await checkAttendeeGate(PARENT, deps), { gated: true, via: "referral" });
  const { deps: none } = facts({ referral: "none" });
  assert.deepEqual(await checkAttendeeGate(PARENT, none), { gated: false });
});

test("an organiser who is also Stripe-verified still reads as organiser — the Studio link depends on the word", async () => {
  const { deps } = facts({ events: [{}], stripe: true });
  assert.equal((await checkAttendeeGate(PARENT, deps)).via, "organiser");
});

test("an events read that faults falls through instead of refusing a memory-backed unlock", async () => {
  const fault = new Error("bee timed out");
  const { deps: viaStripe } = facts({ events: fault, stripe: true });
  assert.deepEqual(await checkAttendeeGate(PARENT, viaStripe), { gated: true, via: "stripe" });
  const { deps: viaReferral } = facts({ events: fault, referral: "confirmed" });
  assert.deepEqual(await checkAttendeeGate(PARENT, viaReferral), { gated: true, via: "referral" });
  const { deps: nothing } = facts({ events: fault });
  assert.deepEqual(await checkAttendeeGate(PARENT, nothing), { gated: false });
});

test("a referral read that could not answer refuses — never allows, never throws", async () => {
  const { deps: unavailable } = facts({ referral: "unavailable" });
  assert.deepEqual(await checkAttendeeGate(PARENT, unavailable), { gated: false });
  const { deps: threw } = facts({ referral: new Error("unexpected") });
  assert.deepEqual(await checkAttendeeGate(PARENT, threw), { gated: false });
});

test("the kill-switch passes an account nothing unlocks, and reports the real reason when there is one", async () => {
  const { deps: nothing } = facts({ enforced: false });
  assert.deepEqual(await checkAttendeeGate(PARENT, nothing), { gated: true, via: "disabled" });
  const { deps: stripe } = facts({ enforced: false, stripe: true });
  assert.deepEqual(await checkAttendeeGate(PARENT, stripe), { gated: true, via: "stripe" });
  const { deps: refused } = facts({ enforced: false, referral: "unavailable" });
  assert.deepEqual(await checkAttendeeGate(PARENT, refused), { gated: true, via: "disabled" });
});

test("every fact is asked about the lowercase address — the stores key on it", async () => {
  const { deps, seen } = facts();
  await checkAttendeeGate(PARENT, deps);
  assert.ok(seen.length === 4 && seen.every((p) => p === LOWER), `saw ${seen.join(", ")}`);
});
