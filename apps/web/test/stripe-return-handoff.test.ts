/**
 * The return-tab → waiting-tab handoff for Stripe onboarding (#508).
 *
 * Properties pinned: the message is a NUDGE and never the answer (a message
 * claiming completion cannot end the wait — only a successful server read can);
 * the listener actually delivers, and stops delivering once the modal closes;
 * and a foreign message on a same-origin channel is ignored.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STRIPE_HANDOFF_CHANNEL,
  isStripeReturnMessage,
  postStripeReturn,
  shouldStopWaiting,
  stripeReturnMessage,
  subscribeStripeReturn,
  type StripeHandoffChannel,
  type StripeHandoffChannelFactory,
  type StripeReturnMessage,
} from "../src/lib/creator/dashboard/stripe-return-handoff.js";

/** An in-process stand-in for BroadcastChannel: same rule that a channel never
 *  receives its own posts, minus the async delivery that would only add flake. */
function fakeBus() {
  const channels: StripeHandoffChannel[] = [];
  const names: string[] = [];
  const make: StripeHandoffChannelFactory = (name) => {
    names.push(name);
    const ch: StripeHandoffChannel = {
      onmessage: null,
      postMessage: (message) => {
        for (const other of [...channels]) if (other !== ch) other.onmessage?.({ data: message });
      },
      close: () => {
        const i = channels.indexOf(ch);
        if (i >= 0) channels.splice(i, 1);
      },
    };
    channels.push(ch);
    return ch;
  };
  return { make, names, channels };
}

test("the message shape is the one both tabs agree on", () => {
  assert.deepEqual(stripeReturnMessage(true), {
    type: "stripe-onboarding-returned",
    onboardingComplete: true,
  });
  assert.deepEqual(stripeReturnMessage(false), {
    type: "stripe-onboarding-returned",
    onboardingComplete: false,
  });
  assert.equal(isStripeReturnMessage(stripeReturnMessage(false)), true);
  for (const junk of [
    null,
    "stripe-onboarding-returned",
    { type: "something-else", onboardingComplete: true },
    { type: "stripe-onboarding-returned" },
    { type: "stripe-onboarding-returned", onboardingComplete: "yes" },
  ]) {
    assert.equal(isStripeReturnMessage(junk), false);
  }
});

test("both tabs open the SAME channel", () => {
  const bus = fakeBus();
  const stop = subscribeStripeReturn(() => {}, bus.make);
  postStripeReturn(true, bus.make);
  stop();
  assert.deepEqual(bus.names, [STRIPE_HANDOFF_CHANNEL, STRIPE_HANDOFF_CHANNEL]);
});

test("the waiting modal re-checks on every message but leaves the wait only when the SERVER says complete", () => {
  const bus = fakeBus();
  // The modal's own state and the real rule it applies; only the network read is
  // stubbed, so a broken rule here is a broken modal.
  let waiting = true;
  let onconnected = 0;
  const refreshes: StripeReturnMessage[] = [];
  let serverStatus: { ok: boolean; onboardingComplete?: boolean } = { ok: true, onboardingComplete: false };
  const unsubscribe = subscribeStripeReturn((m) => {
    refreshes.push(m);
    if (shouldStopWaiting(serverStatus)) {
      waiting = false;
      onconnected++;
    }
  }, bus.make);

  postStripeReturn(false, bus.make);
  assert.equal(refreshes.length, 1, "an incomplete return still triggers the re-check");
  assert.equal(waiting, true);

  // A message can be stale, or from a tab we did not open: it may say "done"
  // while the account is not. The server read is what decides.
  postStripeReturn(true, bus.make);
  assert.equal(refreshes.length, 2);
  assert.equal(waiting, true, "the message's own claim never ends the wait");
  assert.equal(onconnected, 0);

  serverStatus = { ok: true, onboardingComplete: true };
  postStripeReturn(true, bus.make);
  assert.equal(refreshes.length, 3);
  assert.equal(waiting, false, "a completed server read ends the wait");
  assert.equal(onconnected, 1);

  unsubscribe();
  postStripeReturn(true, bus.make);
  assert.equal(refreshes.length, 3, "a closed modal listens to nothing");
});

test("a foreign message on the same-origin channel is ignored", () => {
  const bus = fakeBus();
  let refreshes = 0;
  const stop = subscribeStripeReturn(() => refreshes++, bus.make);
  bus.make(STRIPE_HANDOFF_CHANNEL).postMessage({ type: "some-other-feature", onboardingComplete: true });
  assert.equal(refreshes, 0);
  stop();
});

test("an ERROR envelope never reads as done — it is truthy, and onboardingComplete may ride along", () => {
  assert.equal(shouldStopWaiting({ ok: false, onboardingComplete: true }), false);
  assert.equal(shouldStopWaiting({ ok: true, onboardingComplete: true }), true);
  assert.equal(shouldStopWaiting({ ok: true, onboardingComplete: false }), false);
  assert.equal(shouldStopWaiting({ ok: true }), false);
  assert.equal(shouldStopWaiting(null), false);
});

test("a browser with no BroadcastChannel degrades silently — the modal keeps its fallbacks", () => {
  assert.equal(postStripeReturn(true, null), false);
  const stop = subscribeStripeReturn(() => assert.fail("nothing can arrive"), null);
  stop();
});
