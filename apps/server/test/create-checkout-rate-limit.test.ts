/**
 * `/create-checkout` is bounded per client IP (#463).
 *
 * The route is unauthenticated and CORS-open, and every call that gets past
 * validation spends: a Swarm event read, chain reads, and a Checkout Session on
 * the organiser's connected account. `/reserve` is limited, but a reservation is
 * OPTIONAL — so for a caller that never asks for a hold, this limiter is the only
 * thing standing in front of that spend.
 *
 * The route runs end to end through Hono here. Only Bee is faked, and it is faked
 * as a COUNTER that answers as whichever event was asked for, with no series: a
 * permitted request therefore really does run the read path (a fresh event id
 * every time, so the event cache never answers for one) and stops at "Series not
 * found". That makes "did this request read the event feed?" something the test
 * OBSERVES rather than infers — which is the whole assertion behind "a refused
 * request spends nothing". Outbound HTTP is a tripwire for the same reason:
 * nothing in this harness should reach the network, and a Stripe call would.
 *
 * Date.now is frozen for the file, so the 60-second window is a property of the
 * test rather than of how fast the machine happened to run it. `setTimeout` is
 * deliberately left alone.
 */

import test, { after, before, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import { Hono } from "hono";
import type { Bee } from "@ethersphere/bee-js";

process.chdir(mkdtempSync(join(tmpdir(), "woco-create-checkout-rate-")));
// An unreachable Bee and no Stripe key — `getStripe()` throws without one, so a
// Stripe call could not quietly succeed even if the tripwire below missed it.
process.env.BEE_URL = "http://127.0.0.1:1";
process.env.EMAIL_HASH_SECRET ??= "0".repeat(64);
process.env.FEED_PRIVATE_KEY ??= "11".repeat(32);
delete process.env.STRIPE_SECRET_KEY;

const { stripeRoutes } = await import("../src/routes/stripe.js");
const { __setBeeForTests } = await import("../src/config/swarm.js");

/** Feed reads attempted since the last reset — the Swarm spend, observed. */
let feedReads = 0;
/** What the fake Bee's next event-feed answer identifies itself as. */
let feedEventId = "";

__setBeeForTests({
  makeFeedReader() {
    feedReads++;
    return {
      async downloadPayload() {
        return {
          payload: new TextEncoder().encode(JSON.stringify({ eventId: feedEventId, series: [] })),
        };
      },
    };
  },
} as unknown as Bee);

/** Outbound calls attempted. A tripwire, not a mock: nothing should fire it. */
let outbound = 0;
function tripwire(what: string) {
  return () => {
    outbound++;
    throw new Error(`unexpected outbound ${what} — this suite must reach no network`);
  };
}
globalThis.fetch = tripwire("fetch") as unknown as typeof fetch;
(http as unknown as Record<string, unknown>)["request"] = tripwire("http.request");
(https as unknown as Record<string, unknown>)["request"] = tripwire("https.request");

const app = new Hono();
app.route("/api/stripe", stripeRoutes);

let eventSeq = 0;
/** A body that passes every field check and goes on to the spend. */
function validBody(): Record<string, unknown> {
  return {
    eventId: `evt-rate-${++eventSeq}`,
    seriesId: "ser-1",
    claimerEmail: "buyer@example.com",
  };
}

async function post(ip: string, body: Record<string, unknown> | string): Promise<Response> {
  if (typeof body !== "string" && typeof body.eventId === "string") feedEventId = body.eventId;
  return app.request("/api/stripe/create-checkout", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Spend the whole minute's budget for one connection. */
async function exhaust(ip: string): Promise<void> {
  for (let i = 1; i <= 30; i++) {
    const res = await post(ip, validBody());
    assert.notEqual(res.status, 429, `attempt ${i} is inside the limit`);
  }
}

before(() => {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-11T12:00:00Z") });
});
after(() => {
  mock.timers.reset();
});

test("the 30th checkout attempt in a minute is served; the 31st is refused", async () => {
  const ip = "203.0.113.7";
  feedReads = 0;
  await exhaust(ip);
  assert.ok(feedReads > 0, "a permitted attempt goes on to read the event feed");

  const refused = await post(ip, validBody());
  assert.equal(refused.status, 429);
});

test("a refusal is the API envelope, a sentence a buyer can act on, and Retry-After", async () => {
  const ip = "203.0.113.8";
  await exhaust(ip);

  const res = await post(ip, validBody());
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "60");

  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  // Neither client maps error codes to copy — apps/web raises `data.error` as a
  // CheckoutError message, packages/embed assigns it straight to `st.error` — so
  // whatever is in this field is what the buyer reads.
  assert.match(body.error, /^Too many checkout attempts from your connection\./);
});

test("a refused attempt reads no event feed and makes no outbound call", async () => {
  const ip = "203.0.113.9";
  await exhaust(ip);

  feedReads = 0;
  outbound = 0;
  const res = await post(ip, validBody());

  assert.equal(res.status, 429);
  assert.equal(feedReads, 0, "the Swarm event read is the first thing past the limiter, and it did not run");
  assert.equal(outbound, 0, "nothing left the process — a Checkout Session included");
});

test("malformed JSON is answered 400 without spending the caller's budget", async () => {
  const ip = "203.0.113.10";
  for (let i = 0; i < 30; i++) {
    const res = await post(ip, "{not json");
    assert.equal(res.status, 400);
  }
  const good = await post(ip, validBody());
  assert.notEqual(good.status, 429, "thirty malformed bodies leave the budget intact");
});

test("a request missing eventId/seriesId is answered 400 without spending the caller's budget", async () => {
  const ip = "203.0.113.11";
  for (let i = 0; i < 30; i++) {
    const res = await post(ip, { claimerEmail: "buyer@example.com" });
    assert.equal(res.status, 400);
  }
  const good = await post(ip, validBody());
  assert.notEqual(good.status, 429);
});

test("a request with neither an email nor a session is answered 400 without spending the caller's budget", async () => {
  // The last check before the limiter, so this is what pins the ORDER: refusing
  // it after recording would let a caller with no way to buy consume the budget
  // of one who has.
  const ip = "203.0.113.12";
  for (let i = 0; i < 30; i++) {
    const res = await post(ip, { eventId: `evt-anon-${i}`, seriesId: "ser-1" });
    assert.equal(res.status, 400);
  }
  const good = await post(ip, validBody());
  assert.notEqual(good.status, 429);
});

test("budgets are per client IP", async () => {
  const busy = "203.0.113.13";
  const neighbour = "198.51.100.4";
  await exhaust(busy);

  assert.equal((await post(busy, validBody())).status, 429);
  const other = await post(neighbour, validBody());
  assert.notEqual(other.status, 429, "another connection is untouched by the first one's spending");
});
