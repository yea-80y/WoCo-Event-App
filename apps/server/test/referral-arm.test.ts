/**
 * Armed referrals (`lib/campaign/referral-arm.ts`) and the hook that fires them
 * (`onStripeVerified` in `lib/stripe/accounts.ts`).
 *
 * The properties:
 *   - nothing is confirmed for an account Stripe has not verified;
 *   - the arm is a pointer: what is confirmed is exactly the referee, feed and
 *     referrer it holds, and the issuer decides the rest;
 *   - only `unavailable` keeps the arm, so a fault is retried and a final answer
 *     is never asked again;
 *   - the first arm stands;
 *   - the store announces every write that leaves an account verified, none that
 *     does not, and a throwing listener never fails the Stripe write.
 *
 * MUTATION CHECK: drop the `verified` check, disarm on `unavailable`, let a
 * second arm overwrite, announce unverified writes, or let a listener's throw
 * escape, and a test goes red.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfirmResult } from "../src/lib/campaign/issuer.js";

const REFEREE = "0x1111111111111111111111111111111111111111";
const REFERRER = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";
const FEED = "0x4444444444444444444444444444444444444444";

type ArmMod = typeof import("../src/lib/campaign/referral-arm.js");
type AccountsMod = typeof import("../src/lib/stripe/accounts.js");
let arm: ArmMod;
let accounts: AccountsMod;
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "woco-referral-arm-"));
  process.chdir(dir);
  arm = await import("../src/lib/campaign/referral-arm.js");
  accounts = await import("../src/lib/stripe/accounts.js");
});

beforeEach(() => arm.resetArmsForTest());

const record = { referee: REFEREE, refereeFeed: FEED, referrer: REFERRER } as unknown;

function deps(verified: boolean, result: ConfirmResult | Error) {
  const calls: Array<{ referee: string; refereeFeed: string; referrer: string }> = [];
  return {
    calls,
    deps: {
      verified: () => verified,
      confirm: async (args: { referee: string; refereeFeed: string; referrer: string }) => {
        calls.push(args);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
}

test("nothing armed: no confirm", async () => {
  const h = deps(true, { status: "confirmed", record } as ConfirmResult);
  assert.equal(await arm.confirmArmedReferral(REFEREE, h.deps), "none");
  assert.equal(h.calls.length, 0);
});

test("not verified: no confirm, and the arm waits", async () => {
  arm.armReferral(REFEREE, REFERRER, FEED);
  const h = deps(false, { status: "confirmed", record } as ConfirmResult);
  assert.equal(await arm.confirmArmedReferral(REFEREE, h.deps), "not-verified");
  assert.equal(h.calls.length, 0);
  assert.ok(arm.armedReferral(REFEREE));
});

test("verified: confirms exactly the armed referee, feed and referrer, then disarms", async () => {
  arm.armReferral(REFEREE.toUpperCase().replace("0X", "0x"), REFERRER, FEED);
  const h = deps(true, { status: "confirmed", record } as ConfirmResult);
  assert.equal(await arm.confirmArmedReferral(REFEREE, h.deps), "confirmed");
  assert.deepEqual(h.calls, [{ referee: REFEREE, refereeFeed: FEED, referrer: REFERRER }]);
  assert.equal(arm.armedReferral(REFEREE), undefined);
});

test("unavailable and a throw keep the arm for a retry", async () => {
  arm.armReferral(REFEREE, REFERRER, FEED);
  const down = deps(true, { status: "unavailable", reason: "x" });
  assert.equal(await arm.confirmArmedReferral(REFEREE, down.deps), "retry");
  assert.ok(arm.armedReferral(REFEREE));
  const threw = deps(true, new Error("boom"));
  assert.equal(await arm.confirmArmedReferral(REFEREE, threw.deps), "retry");
  assert.ok(arm.armedReferral(REFEREE));
});

for (const status of ["already", "no-statement", "retracted"] as const) {
  test(`${status} is final: the arm is dropped`, async () => {
    arm.armReferral(REFEREE, REFERRER, FEED);
    const result = (status === "already" ? { status, record } : { status }) as ConfirmResult;
    const h = deps(true, result);
    assert.equal(await arm.confirmArmedReferral(REFEREE, h.deps), status);
    assert.equal(arm.armedReferral(REFEREE), undefined);
  });
}

test("the first arm stands", () => {
  arm.armReferral(REFEREE, REFERRER, FEED);
  arm.armReferral(REFEREE, OTHER, FEED);
  assert.equal(arm.armedReferral(REFEREE)?.referrer, REFERRER);
});

test("an arm is persisted", () => {
  arm.armReferral(REFEREE, REFERRER, FEED);
  const onDisk = JSON.parse(readFileSync(join(dir, ".data", "referral-arms.json"), "utf-8"));
  assert.equal(onDisk[REFEREE].referrer, REFERRER);
  assert.equal(onDisk[REFEREE].feed, FEED);
});

test("the store announces verified writes only, and survives a throwing listener", () => {
  const heard: string[] = [];
  accounts.onStripeVerified(() => { throw new Error("listener fault"); });
  accounts.onStripeVerified((a) => heard.push(a));

  accounts.setStripeAccount(REFEREE, "acct_arm", false);
  assert.deepEqual(heard, []);

  accounts.updateOnboardingStatus("acct_arm", true);
  assert.deepEqual(heard, [REFEREE]);
  assert.equal(accounts.stripeVerificationComplete(REFEREE), true);

  accounts.setStripeAccount(REFEREE, "acct_arm", true);
  assert.deepEqual(heard, [REFEREE, REFEREE]);

  accounts.updateOnboardingStatus("acct_arm", false);
  assert.deepEqual(heard, [REFEREE, REFEREE]);
});
