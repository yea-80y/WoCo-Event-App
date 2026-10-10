/**
 * The wait for a Web3Auth sign-in result (`web3auth-signin-wait.ts`; an iPhone,
 * 2026-10-10): the SDK's own promise can stay open long after the pop-up finished
 * (its result travels over a socket the SDK re-asks only on `visibilitychange`),
 * so the wait re-checks the SDK's state itself, bounds the spinner by the time
 * the person has spent LOOKING at it, and goes on listening after that.
 *
 * Pure: a scripted page (events, watching, the poll clock) and a scripted SDK.
 *
 * MUTATION: drop `freshConnection` from `check()` and "a rehydrated session is
 * never adopted" goes red; count all time instead of watched time in `tick()` and
 * "time in the pop-up does not count" goes red; stop ignoring the post-stall
 * cancel and "a stall keeps listening" goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  awaitWeb3AuthSignIn,
  SIGN_IN_POLL_MS,
  SIGN_IN_STALL_AFTER_WATCHED_MS,
  SIGN_IN_GRACE_MS,
  SIGN_IN_HARD_LIMIT_MS,
  type SignInWaitDeps,
} from "../src/lib/auth/web3auth-signin-wait.js";

type Provider = { key: string };

class FakeSdk extends EventEmitter {
  connected = false;
  status = "ready";
  cachedConnector: string | null = null;
  provider: Provider | null = null;
  async logout(): Promise<void> {}
  /** The pop-up's result lands: the connector connects (not a rehydration). */
  lateResult(key: string): void {
    this.connected = true;
    this.status = "connected";
    this.provider = { key };
    this.emit("connected", { reconnected: false });
  }
  /** A stored session finished rehydrating (the SDK marks it so). */
  rehydrated(key: string): void {
    this.connected = true;
    this.status = "connected";
    this.provider = { key };
    this.emit("connected", { reconnected: true });
  }
}

/** The page: who is listening, whether the person is looking, and the poll. */
class Page {
  listeners = new Set<() => void>();
  watching = false;
  polls = new Map<unknown, () => void>();
  deps: SignInWaitDeps = {
    listen: (fn) => {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    },
    watching: () => this.watching,
    setInterval: (fn, ms) => {
      assert.equal(ms, SIGN_IN_POLL_MS);
      const h = {};
      this.polls.set(h, fn);
      return h;
    },
    clearInterval: (h) => void this.polls.delete(h),
  };
  /** Move the clock by `ms` in poll ticks. */
  tick(ms: number): void {
    for (let t = 0; t < ms; t += SIGN_IN_POLL_MS) for (const fn of [...this.polls.values()]) fn();
  }
  /** `focus` / `pageshow` / `visibilitychange`. */
  event(): void {
    for (const fn of [...this.listeners]) fn();
  }
}

const isCancel = (e: unknown) => e instanceof Error && e.message === "User closed the modal";

/** A connect() whose result the test hands out. */
function pending<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

function start(page: Page, sdk: FakeSdk, connect: Promise<Provider | null>, onStall = () => {}) {
  return awaitWeb3AuthSignIn<Provider>(sdk, connect, { onStall, isCancel }, page.deps);
}

test("the SDK's promise resolving is the sign-in, and everything is unhooked", async () => {
  const page = new Page();
  const sdk = new FakeSdk();
  const c = pending<Provider | null>();
  const wait = start(page, sdk, c.promise);
  assert.equal(page.listeners.size, 1);
  assert.equal(page.polls.size, 1);
  assert.equal(sdk.listenerCount("connected"), 1);
  c.resolve({ key: "k" });
  assert.deepEqual(await wait.outcome, { kind: "signed-in", provider: { key: "k" }, recovered: false });
  assert.equal(page.listeners.size, 0);
  assert.equal(page.polls.size, 0);
  assert.equal(sdk.listenerCount("connected"), 0);
});

test("a result that lands while the SDK's promise stays open is picked up on the next page event", async () => {
  const page = new Page();
  const sdk = new FakeSdk();
  const wait = start(page, sdk, pending<Provider | null>().promise);
  // The connector connected (the pop-up's result reached it), but nothing resolved
  // the modal's promise. Any of focus / pageshow / visibilitychange re-reads it.
  sdk.removeAllListeners("connected"); // pretend the event itself was missed
  sdk.connected = true;
  sdk.status = "connected";
  sdk.provider = { key: "late" };
  page.event();
  await settle();
  // Not adopted: no CONNECTED event this attempt saw says it is its own connection.
  let done = false;
  void wait.outcome.then(() => (done = true));
  await settle();
  assert.equal(done, false, "a live status alone is not proof the sign-in made it");
  wait.abort();
  await wait.outcome;
});

test("a CONNECTED event this attempt made completes the sign-in at once, even with the SDK's promise open", async () => {
  const page = new Page();
  const sdk = new FakeSdk();
  const wait = start(page, sdk, pending<Provider | null>().promise);
  sdk.lateResult("late");
  assert.deepEqual(await wait.outcome, { kind: "signed-in", provider: { key: "late" }, recovered: true });
});

test("the poll re-reads the state too: a connection seen before the provider was there is picked up later", async () => {
  const page = new Page();
  const sdk = new FakeSdk();
  const wait = start(page, sdk, pending<Provider | null>().promise);
  sdk.emit("connected", { reconnected: false }); // the event, with the state not yet live
  let done = false;
  void wait.outcome.then(() => (done = true));
  await settle();
  assert.equal(done, false);
  sdk.connected = true;
  sdk.status = "connected";
  sdk.provider = { key: "polled" };
  page.tick(SIGN_IN_POLL_MS);
  assert.deepEqual(await wait.outcome, { kind: "signed-in", provider: { key: "polled" }, recovered: true });
});

test("a rehydrated session appearing mid-wait is never adopted (#182)", async () => {
  const page = new Page();
  const sdk = new FakeSdk();
  const c = pending<Provider | null>();
  const wait = start(page, sdk, c.promise);
  sdk.rehydrated("survivor");
  page.event();
  page.tick(5 * SIGN_IN_POLL_MS);
  let done = false;
  void wait.outcome.then(() => (done = true));
  await settle();
  assert.equal(done, false, "a live status from storage is not this sign-in");
  // The SDK then closes its modal over it: a cancel, for the caller's survivor check.
  c.reject(new Error("User closed the modal"));
  assert.deepEqual(await wait.outcome, { kind: "cancelled" });
});

test("the spinner is bounded by WATCHED time: time in the pop-up does not count", async () => {
  const page = new Page();
  const sdk = new FakeSdk();
  let stalls = 0;
  const wait = start(page, sdk, pending<Provider | null>().promise, () => stalls++);
  page.watching = false; // in the pop-up / another tab
  page.tick(10 * SIGN_IN_STALL_AFTER_WATCHED_MS);
  assert.equal(stalls, 0, "no stall while the person is not looking at this page");
  page.watching = true;
  page.tick(SIGN_IN_STALL_AFTER_WATCHED_MS - SIGN_IN_POLL_MS);
  assert.equal(stalls, 0);
  page.tick(SIGN_IN_POLL_MS);
  assert.equal(stalls, 1, "the spinner's time is up");
  page.tick(5 * SIGN_IN_POLL_MS);
  assert.equal(stalls, 1, "said once");
  wait.abort();
  await wait.outcome;
});

test("a stall keeps listening: the SDK's cancel from our own modal close is ignored, a late result still signs in", async () => {
  const page = new Page();
  const sdk = new FakeSdk();
  const c = pending<Provider | null>();
  const wait = start(page, sdk, c.promise);
  page.watching = true;
  page.tick(SIGN_IN_STALL_AFTER_WATCHED_MS);
  // Closing the SDK's modal rejects its promise while nothing is connected.
  c.reject(new Error("User closed the modal"));
  let done = false;
  void wait.outcome.then(() => (done = true));
  await settle();
  assert.equal(done, false, "the wait outlives the SDK's promise after a stall");
  page.tick(60 * SIGN_IN_POLL_MS);
  sdk.lateResult("after-stall");
  assert.deepEqual(await wait.outcome, { kind: "signed-in", provider: { key: "after-stall" }, recovered: true });
});

test("a cancel BEFORE a stall is a cancel (the person closed the SDK's modal or pop-up)", async () => {
  const page = new Page();
  const sdk = new FakeSdk();
  const c = pending<Provider | null>();
  const wait = start(page, sdk, c.promise);
  c.reject(new Error("User closed the modal"));
  assert.deepEqual(await wait.outcome, { kind: "cancelled" });
});

test("a stalled wait with nothing in the grace times out", async () => {
  const page = new Page();
  const sdk = new FakeSdk();
  const wait = start(page, sdk, pending<Provider | null>().promise);
  page.watching = true;
  page.tick(SIGN_IN_STALL_AFTER_WATCHED_MS);
  page.watching = false;
  page.tick(SIGN_IN_GRACE_MS - SIGN_IN_POLL_MS);
  let done = false;
  void wait.outcome.then(() => (done = true));
  await settle();
  assert.equal(done, false);
  page.tick(SIGN_IN_POLL_MS);
  assert.deepEqual(await wait.outcome, { kind: "timed-out" });
  assert.equal(page.polls.size, 0);
});

test("the hard ceiling ends a wait the page never reported as watched", async () => {
  const page = new Page();
  const sdk = new FakeSdk();
  let stalls = 0;
  const wait = start(page, sdk, pending<Provider | null>().promise, () => stalls++);
  page.watching = false;
  page.tick(SIGN_IN_HARD_LIMIT_MS);
  assert.deepEqual(await wait.outcome, { kind: "timed-out" });
  assert.equal(stalls, 0);
});

test("abort settles as a cancel at once, before or after a stall", async () => {
  for (const stallFirst of [false, true]) {
    const page = new Page();
    const sdk = new FakeSdk();
    const wait = start(page, sdk, pending<Provider | null>().promise);
    if (stallFirst) {
      page.watching = true;
      page.tick(SIGN_IN_STALL_AFTER_WATCHED_MS);
    }
    wait.abort();
    assert.deepEqual(await wait.outcome, { kind: "cancelled" });
    assert.equal(page.listeners.size, 0);
  }
});

test("any other SDK failure is passed on as itself; a null provider is a cancel", async () => {
  const page = new Page();
  const sdk = new FakeSdk();
  const c = pending<Provider | null>();
  const wait = start(page, sdk, c.promise);
  c.reject(new Error("boom"));
  const out = await wait.outcome;
  assert.equal(out.kind, "failed");
  assert.equal(out.kind === "failed" && (out.error as Error).message, "boom");

  const c2 = pending<Provider | null>();
  const wait2 = start(new Page(), new FakeSdk(), c2.promise);
  c2.resolve(null);
  assert.deepEqual(await wait2.outcome, { kind: "cancelled" });
});

test("once settled, nothing later changes the outcome", async () => {
  const page = new Page();
  const sdk = new FakeSdk();
  const c = pending<Provider | null>();
  const wait = start(page, sdk, c.promise);
  wait.abort();
  c.resolve({ key: "too-late" });
  sdk.lateResult("too-late");
  page.event();
  assert.deepEqual(await wait.outcome, { kind: "cancelled" });
});
