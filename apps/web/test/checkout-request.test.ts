/**
 * Paying by card never opens a wallet. A checkout is signed only when the
 * buyer's purchase links to their account, and ClaimButton decides that from
 * `auth.isAuthenticated`: a session key already on the device. A wallet login
 * with no session key used to get a signature popup in place of Stripe.
 *
 * The transport is run for real against fakes; ClaimButton and stripe.ts are
 * checked as text, since they import a runes module this suite cannot execute.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sendCheckout, type CheckoutIo } from "../src/lib/api/checkout-request.js";

function fakeIo() {
  const calls: { signed: Array<{ path: string; body: unknown }>; plain: Array<{ url: string; init: RequestInit }> } = {
    signed: [],
    plain: [],
  };
  const io: CheckoutIo = {
    apiBase: "https://api.test",
    async authPost(path, body) {
      calls.signed.push({ path, body });
      return { ok: true, url: "https://stripe.test/signed" };
    },
    async fetch(url, init) {
      calls.plain.push({ url, init });
      return { json: async () => ({ ok: true, url: "https://stripe.test/guest" }) };
    },
  };
  return { io, calls };
}

const BODY = { eventId: "ev", seriesId: "s1", claimerEmail: "buyer@example.com" };

test("not linked: a plain request, no session headers, nothing signed", async () => {
  const { io, calls } = fakeIo();
  const r = await sendCheckout("/api/stripe/create-checkout", BODY, false, io);
  assert.equal(r.url, "https://stripe.test/guest");
  assert.equal(calls.signed.length, 0, "signing would mint a session: a wallet popup");
  assert.equal(calls.plain.length, 1);
  assert.equal(calls.plain[0]!.url, "https://api.test/api/stripe/create-checkout");
  const headers = calls.plain[0]!.init.headers as Record<string, string>;
  assert.deepEqual(Object.keys(headers).filter((h) => /^x-session/i.test(h)), []);
  assert.deepEqual(JSON.parse(calls.plain[0]!.init.body as string), BODY);
});

test("linked: the request is signed so the server binds the verified account", async () => {
  const { io, calls } = fakeIo();
  const r = await sendCheckout("/api/stripe/create-checkout", BODY, true, io);
  assert.equal(r.url, "https://stripe.test/signed");
  assert.equal(calls.plain.length, 0);
  assert.deepEqual(calls.signed, [{ path: "/api/stripe/create-checkout", body: BODY }]);
});

const SRC = new URL("../src/lib/", import.meta.url).pathname;
const read = (rel: string) => readFileSync(SRC + rel, "utf8");

test("createCheckoutSession takes the decision from its caller, never from who is signed in", () => {
  const stripe = read("api/stripe.ts");
  const start = stripe.indexOf("export async function createCheckoutSession");
  const end = stripe.indexOf("\nexport ", start + 1);
  const fn = stripe.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(fn, /auth\.is(Connected|Authenticated)/);
  assert.match(fn, /sendCheckout\([^)]*params\.linkAccount/);
});

test("ClaimButton links only with a session key on the device, and asks for an email otherwise", () => {
  const claim = read("attendee/events/ClaimButton.svelte");
  assert.match(claim, /const linked = \$derived\(auth\.isAuthenticated\)/);
  assert.match(claim, /linkAccount,\s*\n\s*\}\);/, "the Pay click passes its own decision");
  assert.match(claim, /authConnected=\{linked\}/);
  assert.match(claim, /showEmailInput=\{!linked && !hasEmailField\}/);
  const connectedUses = claim.split("\n").filter((l) => l.includes("auth.isConnected"));
  assert.ok(
    connectedUses.every((l) => l.includes("loginRequest.available")),
    "being signed in must not decide anything but copy: " + connectedUses.join(" | "),
  );
});

test("the return screen promises the passport only when the checkout it came from was linked", () => {
  const purchased = read("attendee/events/EventPurchased.svelte");
  assert.doesNotMatch(purchased, /auth\.isConnected/, "who is signed in now is not what was sent");
  assert.match(purchased, /\{#if _stash\.linked\}/);
  assert.match(purchased, /linked = parsed\.linked === true/);
});
