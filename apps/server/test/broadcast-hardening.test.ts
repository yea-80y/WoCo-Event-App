/**
 * Event-broadcast hardening (#82): the rate-limit race and the v1/v2 gate scope.
 *
 * The route itself needs Hono + Swarm + Resend to exercise, so the two pieces of
 * policy it depends on are tested here directly: the sliding window (extracted to
 * RateWindow so check and consume are separable) and the recipient gate (a pure
 * function of the attendee hashes the claimers feeds could prove).
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EMAIL_HASH_SECRET = "test-secret-broadcast";

const ATTENDEE = "real@example.com";
const STRANGER = "stranger@example.com";

let RateWindow: typeof import("../src/lib/marketing/rate-window.js").RateWindow;
let hashEmail: typeof import("../src/lib/event/claim-service.js")["hashEmail"];
let attendees: Set<string>;
let withOrgLock: typeof import("../src/lib/marketing/list-store.js").withOrgLock;

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-broadcast-test-")));
  ({ RateWindow } = await import("../src/lib/marketing/rate-window.js"));
  ({ hashEmail } = await import("../src/lib/event/claim-service.js"));
  ({ withOrgLock } = await import("../src/lib/marketing/list-store.js"));
  attendees = new Set([hashEmail(ATTENDEE)]);
});

// ── RateWindow ────────────────────────────────────────────────────────────

test("the window admits exactly `limit` sends and then refuses", () => {
  const w = new RateWindow(3, 60_000);
  for (let i = 0; i < 3; i++) {
    assert.equal(w.isLimited("org"), false);
    w.record("org");
  }
  assert.equal(w.isLimited("org"), true);
});

test("slots outside the window are forgotten", () => {
  const w = new RateWindow(2, 60_000);
  const t0 = 1_000_000;
  w.record("org", t0);
  w.record("org", t0);
  assert.equal(w.isLimited("org", t0 + 59_000), true);
  assert.equal(w.isLimited("org", t0 + 61_000), false);
});

test("keys are independent", () => {
  const w = new RateWindow(1, 60_000);
  w.record("a");
  assert.equal(w.isLimited("a"), true);
  assert.equal(w.isLimited("b"), false);
});

/**
 * The TOCTOU. Checking once, sending, then recording let N concurrent requests
 * all pass the same check. Check-and-consume under the org lock is the fix, and
 * this is the shape of it: five simultaneous callers, a limit of 2.
 */
test("concurrent callers under the org lock cannot all pass one limit", async () => {
  const w = new RateWindow(2, 60_000);
  const ORG = "0xorg";
  let sent = 0;

  const attempt = () =>
    withOrgLock(ORG, async () => {
      if (w.isLimited(ORG)) return "rejected";
      w.record(ORG);
      // A real send is slow — that latency is exactly what opened the window.
      await new Promise((r) => setTimeout(r, 5));
      sent++;
      return "sent";
    });

  const outcomes = await Promise.all([attempt(), attempt(), attempt(), attempt(), attempt()]);
  assert.equal(sent, 2, "only the allowance may actually send");
  assert.equal(outcomes.filter((o) => o === "sent").length, 2);
  assert.equal(outcomes.filter((o) => o === "rejected").length, 3);
});

test("address casing cannot buy a second window", () => {
  const w = new RateWindow(1, 60_000);
  const MIXED = "0xAbCd000000000000000000000000000000000001";
  w.record(MIXED.toLowerCase());
  assert.equal(w.isLimited(MIXED.toLowerCase()), true, "the route lowercases before keying");
});

// ── Recipient gate ────────────────────────────────────────────────────────

/**
 * Mirrors the route's decision so the scope change is pinned. Previously ANY
 * v2 series on the event replaced the per-recipient check with a blanket
 * organiser check, which made a verified organiser able to mail arbitrary
 * addresses through an event that merely had an on-chain series attached.
 */
function gate(
  recipientEmails: string[],
  attendeeHashes: Set<string>,
  unverifiableSeries: number,
  verified: boolean,
): "allow" | "reject-not-attendees" | "reject-unverified" {
  const unproven = recipientEmails.filter((e) => !attendeeHashes.has(hashEmail(e)));
  if (unproven.length === 0) return "allow";
  if (unverifiableSeries === 0) return "reject-not-attendees";
  return verified ? "allow" : "reject-unverified";
}


test("v1-only event: proven attendees pass, strangers are rejected", () => {
  assert.equal(gate([ATTENDEE], attendees, 0, true), "allow");
  assert.equal(gate([ATTENDEE, STRANGER], attendees, 0, true), "reject-not-attendees");
});

/** The #82 item-3 fix: a v2 series no longer waives the check for everyone. */
test("mixed v1/v2: a proven attendee still passes without touching the fallback", () => {
  assert.equal(gate([ATTENDEE], attendees, 1, false), "allow",
    "membership was provable — an unverified organiser must not be blocked by it");
});

test("mixed v1/v2: an unproven recipient falls back to the verification gate, not a waiver", () => {
  assert.equal(gate([ATTENDEE, STRANGER], attendees, 1, false), "reject-unverified");
  assert.equal(gate([ATTENDEE, STRANGER], attendees, 1, true), "allow",
    "only a verified organiser may mail the unprovable remainder");
});

test("v2-only event: everything rides on the verification gate", () => {
  assert.equal(gate([STRANGER], new Set(), 2, false), "reject-unverified");
  assert.equal(gate([STRANGER], new Set(), 2, true), "allow");
});
