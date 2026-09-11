/**
 * A gate binding contains exactly what the store says it contains — and, since
 * #518, no holder key at all.
 *
 * The ed25519 key that used to ride on a binding arrived in a request body, was
 * never checked against anything (#345), and reached disk because `bindTicket`
 * SPREAD the caller's object into the record. So the guard is not "the route no
 * longer reads it" — a route can regress in one line — but the store refusing to
 * persist anything it did not name. This asserts that at the PERSISTED object,
 * not at the type: a type says nothing at runtime about a field an untrusted
 * body put there.
 *
 * MUTATION CHECK: put `...binding` back into the record in `bindTicket` and the
 * first test here goes red.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let bindTicket: typeof import("../src/lib/gate/store.js").bindTicket;
let getBindingsForEvent: typeof import("../src/lib/gate/store.js").getBindingsForEvent;
let toAttendeeKeyRows: typeof import("../src/lib/gate/store.js").toAttendeeKeyRows;

before(async () => {
  // Isolated cwd — the store persists to `.data/` relative to it.
  process.chdir(mkdtempSync(join(tmpdir(), "woco-gate-binding-test-")));
  ({ bindTicket, getBindingsForEvent, toAttendeeKeyRows } = await import("../src/lib/gate/store.js"));
});

const PARENT = "0x1111111111111111111111111111111111111111";
const HOLDER_KEY = "a".repeat(64);

/** Exactly the fields a binding may carry. Everything else is a leak. */
const ALLOWED = ["boundAt", "edition", "emailHash", "eventId", "paid", "parentAddress", "route", "seriesId"];

test("a caller that passes a holder key cannot persist one", () => {
  // Shaped like the old redeem path: an untrusted body field carried straight
  // into the binding. `as` is the point — a caller with a stale type, or a
  // handler spreading a parsed body, is exactly the regression being blocked.
  bindTicket({
    seriesId: "s-leak",
    edition: 1,
    eventId: "e-leak",
    parentAddress: PARENT,
    emailHash: "deadbeef",
    paid: true,
    route: "email-link",
    holderPubKey: HOLDER_KEY,
    somethingElse: "also not a binding field",
  } as unknown as Parameters<typeof bindTicket>[0]);

  const [row] = getBindingsForEvent("e-leak");
  assert.ok(row, "the binding is persisted");
  assert.equal(
    Object.prototype.hasOwnProperty.call(row, "holderPubKey"),
    false,
    "no holder key may reach the persisted binding",
  );
  assert.deepEqual(
    Object.keys(row).sort().filter((k) => !ALLOWED.includes(k)),
    [],
    "no field the store did not name may be persisted",
  );
  // The fields the store DOES name still survive — a whitelist that dropped
  // everything would pass the assertions above and break the gate.
  assert.equal(row.parentAddress, PARENT.toLowerCase(), "the verified parent is the owner of record");
  assert.equal(row.emailHash, "deadbeef");
  assert.equal(row.paid, true);
  assert.equal(row.route, "email-link");
});

test("a leaked key cannot be served to the certificate picker either", () => {
  // Belt and braces: even if a binding somehow held one, the row mapper names
  // its own output fields too.
  const rows = toAttendeeKeyRows([
    {
      seriesId: "s-leak",
      edition: 1,
      eventId: "e-leak",
      parentAddress: PARENT,
      route: "claim",
      boundAt: "2026-09-10T00:00:00.000Z",
      holderPubKey: HOLDER_KEY,
    } as unknown as Parameters<typeof toAttendeeKeyRows>[0][number],
  ]);
  assert.deepEqual(Object.keys(rows[0]!).sort(), ["edition", "route", "seriesId"]);
});

test("optional fields stay absent rather than becoming undefined", () => {
  // `emailHash: undefined` on a JSON-persisted record is not the same as no key
  // at all — it survives a round trip as a missing field but reads as present
  // via `in`, which is what a caller enumerating a binding would see.
  bindTicket({
    seriesId: "s-min",
    edition: 1,
    eventId: "e-min",
    parentAddress: PARENT,
    route: "claim",
  });
  const [row] = getBindingsForEvent("e-min");
  assert.ok(row);
  assert.equal("emailHash" in row, false);
  assert.equal("paid" in row, false);
});
