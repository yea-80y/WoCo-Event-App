/**
 * The server-side decisions slice 4 added, tested at their seams.
 *
 * Both were extracted from route handlers specifically so they could be tested
 * — the sibling of #314 and #342, where a rule that lives only inside a handler
 * behind `requireAuth` is established by reading and by nothing else.
 *
 * The theme is the same as the client half: every failure guarded here is one
 * that would otherwise look like a success. A ticket POD quietly accepting a
 * display counter, or an attendee vanishing from a picker, both render as a
 * perfectly ordinary screen.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Hex0x } from "@woco/shared";
import { validateIssuedCount } from "../src/lib/pod/issued-count.js";
import { toAttendeeKeyRows } from "../src/lib/gate/attendee-keys.js";
import type { GateBinding } from "../src/lib/gate/store.js";

const LOG_OWNER = "0x2222222222222222222222222222222222222222" as Hex0x;
const certBadge = { certLogOwner: LOG_OWNER, supply: 100 };
const chainBadge = { supply: 100 };

// ---------------------------------------------------------------------------
// issuedCount
// ---------------------------------------------------------------------------

test("a CHAIN badge refuses a client-written issuedCount", () => {
  // Derivable server-side from `nextSlot`. Accepting one would let a display
  // number contradict the chain.
  const r = validateIssuedCount(chainBadge, 5);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /certificate badge/i);
});

test("a TICKET POD refuses one too — same rule, and this is the one that matters", () => {
  // Ticket PODs live in the same directory and are chain-sourced. The rule is
  // "has a certLogOwner", not "is not a ticket", so a ticket is refused by
  // construction rather than by an enumerated exception someone can forget.
  const ticket = { supply: 250 };
  assert.equal(validateIssuedCount(ticket, 1).ok, false);
});

test("a certificate badge accepts a count within its declared supply", () => {
  const r = validateIssuedCount(certBadge, 42);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.value, 42);
});

test("0 is accepted — a badge can legitimately have none issued", () => {
  assert.equal(validateIssuedCount(certBadge, 0).ok, true);
});

test("the cap is inclusive, and anything past it is refused", () => {
  assert.equal(validateIssuedCount(certBadge, 100).ok, true);
  assert.equal(validateIssuedCount(certBadge, 101).ok, false);
});

test("non-integers, negatives and non-numbers are refused", () => {
  for (const bad of [-1, 1.5, Number.NaN, Infinity, "5", null, undefined, {}]) {
    assert.equal(
      validateIssuedCount(certBadge, bad).ok,
      false,
      `${String(bad)} must be refused`,
    );
  }
});

test("NOT a ratchet — a later honest run may correct DOWNWARD", () => {
  // Monotonicity would freeze an over-report forever. A run that recomputes
  // distinct holders from a thoroughly-read log must be able to lower it.
  assert.equal(validateIssuedCount(certBadge, 90).ok, true);
  assert.equal(validateIssuedCount(certBadge, 3).ok, true);
});

// ---------------------------------------------------------------------------
// attendee key rows
// ---------------------------------------------------------------------------

const GOOD = "a".repeat(64);

function binding(over: Partial<GateBinding> = {}): GateBinding {
  return {
    seriesId: "s1",
    edition: 1,
    eventId: "e1",
    parentAddress: "0x1111111111111111111111111111111111111111",
    route: "claim",
    boundAt: "2026-08-21T00:00:00.000Z",
    ...over,
  };
}

test("an attendee with NO key is still returned — un-certifiable, not invisible", () => {
  // The whole point. A picker handed only certifiable attendees cannot tell
  // "nobody qualifies" from "the list came back short".
  const rows = toAttendeeKeyRows([binding({ podPubKey: undefined })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.podPubKey, undefined);
  assert.equal(rows[0]!.edition, 1);
});

test("a MALFORMED key is reported as absent, never passed through", () => {
  // Only the redeem path could have stored it, and a certificate signed over
  // garbage is permanent and unrevocable in v1.
  for (const bad of ["nope", "0x" + "a".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64)]) {
    const rows = toAttendeeKeyRows([binding({ podPubKey: bad })]);
    assert.equal(rows.length, 1, "the attendee is still listed");
    assert.equal(rows[0]!.podPubKey, undefined, `${bad.slice(0, 12)} must not be served`);
  }
});

test("a well-formed key is served lowercased", () => {
  const rows = toAttendeeKeyRows([binding({ podPubKey: GOOD.toUpperCase() })]);
  assert.equal(rows[0]!.podPubKey, GOOD);
});

test("route is carried, so provenance survives to the surface", () => {
  const rows = toAttendeeKeyRows([
    binding({ podPubKey: GOOD, route: "claim" }),
    binding({ edition: 2, podPubKey: GOOD, route: "email-link" }),
  ]);
  assert.deepEqual(rows.map((r) => r.route), ["claim", "email-link"]);
});

test("no identity leaks into a picker row", () => {
  // The caller joins on (seriesId, edition) against orders it already renders.
  // Returning parentAddress or emailHash would hand over a second copy of
  // who-is-who for no new capability.
  const rows = toAttendeeKeyRows([binding({ podPubKey: GOOD, emailHash: "deadbeef" })]);
  assert.deepEqual(Object.keys(rows[0]!).sort(), ["edition", "podPubKey", "route", "seriesId"]);
});

test("an empty binding list is an empty row list, not a throw", () => {
  assert.deepEqual(toAttendeeKeyRows([]), []);
});
