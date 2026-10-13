/**
 * The click-free confirm (`lib/campaign/referral-confirm.ts`).
 *
 * It sends exactly when the old button would have shown, and never otherwise:
 *   - not before Stripe says the account is verified;
 *   - not off a confirmation read that could not answer (`readOk: false`);
 *   - not when a confirmation already stands, or there is no statement;
 *   - not once the signed-in account is no longer the one the facts were read for.
 * When it sends, it names the statement's referrer and the caller's feed; a
 * refusal or a throw comes back as `failed`, so the button can offer the retry.
 *
 * MUTATION CHECK: drop any clause of `confirmDue`, or the account check, and a
 * test goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Hex0x, ReferralConfirmationV1 } from "@woco/shared";
import { autoConfirmReferral, confirmDue, type ConfirmFacts } from "../src/lib/campaign/referral-confirm.js";

const REFERRER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex0x;
const FEED = "0xcccccccccccccccccccccccccccccccccccccccc" as Hex0x;
const RECORD = { referrer: REFERRER } as unknown as ReferralConfirmationV1;

const due: ConfirmFacts = {
  statement: { referrer: REFERRER },
  status: { stripeComplete: true, readOk: true, confirmed: null },
};

function run(facts: ConfirmFacts, opts: { same?: boolean; reply?: unknown; throws?: boolean } = {}) {
  const calls: Array<[Hex0x, Hex0x]> = [];
  const outcome = autoConfirmReferral({
    facts,
    feed: FEED,
    stillSameAccount: () => opts.same ?? true,
    confirm: async (referrer, feed) => {
      calls.push([referrer, feed]);
      if (opts.throws) throw new Error("network down");
      return (opts.reply ?? { ok: true, data: { confirmed: RECORD } }) as never;
    },
  });
  return { calls, outcome };
}

test("due: sends the statement's referrer with the caller's feed", async () => {
  const r = run(due);
  assert.deepEqual(await r.outcome, { kind: "confirmed", record: RECORD });
  assert.deepEqual(r.calls, [[REFERRER, FEED]]);
});

const notDue: Array<[string, ConfirmFacts]> = [
  ["Stripe not verified", { ...due, status: { ...due.status!, stripeComplete: false } }],
  ["confirmation read did not answer", { ...due, status: { ...due.status!, readOk: false } }],
  ["already confirmed", { ...due, status: { ...due.status!, confirmed: RECORD } }],
  ["no statement", { ...due, statement: null }],
  ["status did not answer", { ...due, status: null }],
];
for (const [name, facts] of notDue) {
  test(`not due - ${name}: nothing is sent`, async () => {
    assert.equal(confirmDue(facts), false);
    const r = run(facts);
    assert.deepEqual(await r.outcome, { kind: "skip" });
    assert.equal(r.calls.length, 0);
  });
}

test("account switched since the read: nothing is sent", async () => {
  const r = run(due, { same: false });
  assert.deepEqual(await r.outcome, { kind: "skip" });
  assert.equal(r.calls.length, 0);
});

test("a refusal or a throw is failed, carrying the reason", async () => {
  const refused = run(due, { reply: { ok: false, error: "Complete Stripe onboarding first" } });
  assert.deepEqual(await refused.outcome, { kind: "failed", error: "Complete Stripe onboarding first" });
  const threw = run(due, { throws: true });
  assert.deepEqual(await threw.outcome, { kind: "failed", error: "network down" });
});
