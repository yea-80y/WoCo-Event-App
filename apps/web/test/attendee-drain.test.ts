/**
 * Ticket buyer → marketing contact.
 *
 * Two guarantees under test, both of which a naive "newest wins" merge breaks:
 *   1. Only people who ticked the opt-in themselves are ever built into a
 *      contact. Everything else about this feature is downstream of that.
 *   2. A later, less trustworthy record never degrades a better one — not by
 *      overwriting a self-reported name with a CSV one, and not by blanking a
 *      field it simply does not carry.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAttendeeContacts,
  mergeContact,
  applyDrain,
  provenanceRank,
} from "../src/lib/creator/audience/attendee-drain.js";

const NOW = "2026-07-27T00:00:00.000Z";
const opts = (consented: string[]) => ({
  eventTitle: "Warehouse Project",
  eventDate: "2026-09-01",
  addedAt: NOW,
  consented: new Set(consented),
});

// ── Who gets built ─────────────────────────────────────────────────────────

test("only opted-in buyers become contacts", () => {
  const out = buildAttendeeContacts(
    [{ claimerEmail: "yes@x.com" }, { claimerEmail: "no@x.com" }],
    opts(["yes@x.com"]),
  );
  assert.deepEqual(out.map((c) => c.email), ["yes@x.com"]);
});

test("a buyer with no email at all is skipped", () => {
  // Wallet claims carry no address to mail. Nothing to build.
  const out = buildAttendeeContacts([{ fields: { firstName: "Ada" } }], opts([]));
  assert.equal(out.length, 0);
});

test("four tickets is one contact", () => {
  const claims = Array.from({ length: 4 }, () => ({ claimerEmail: "Ada@X.com" }));
  const out = buildAttendeeContacts(claims, opts(["ada@x.com"]));
  assert.equal(out.length, 1);
  assert.equal(out[0].email, "ada@x.com");
});

test("names are read out of organiser-defined order fields", () => {
  const out = buildAttendeeContacts(
    [{ claimerEmail: "a@x.com", fields: { "First Name": "Ada", surname: "Lovelace" } }],
    opts(["a@x.com"]),
  );
  assert.equal(out[0].firstName, "Ada");
  assert.equal(out[0].lastName, "Lovelace");
});

test("a single name field is kept whole rather than split", () => {
  const out = buildAttendeeContacts(
    [{ claimerEmail: "a@x.com", fields: { name: "Ada King de Lovelace" } }],
    opts(["a@x.com"]),
  );
  assert.equal(out[0].firstName, "Ada King de Lovelace");
  assert.equal(out[0].lastName, undefined);
});

test("the event is recorded as the provenance", () => {
  const out = buildAttendeeContacts([{ claimerEmail: "a@x.com" }], opts(["a@x.com"]));
  assert.equal(out[0].source, "event:Warehouse Project");
  assert.equal(out[0].lastEventName, "Warehouse Project");
});

// ── The merge rule ─────────────────────────────────────────────────────────

test("checkout outranks a CSV import, which outranks nothing", () => {
  assert.ok(provenanceRank("event:X") > provenanceRank("manual"));
  assert.ok(provenanceRank("manual") > provenanceRank("csv:list.csv"));
});

test("a CSV name does not overwrite one the attendee typed themselves", () => {
  const self = { email: "a@x.com", firstName: "Ada", source: "event:X", addedAt: "2026-01-01T00:00:00.000Z" };
  const csv = { email: "a@x.com", firstName: "A.", source: "csv:old.csv", addedAt: NOW };
  assert.equal(mergeContact(self, csv).firstName, "Ada");
});

test("but it does fill a field the better record left empty", () => {
  const self = { email: "a@x.com", firstName: "Ada", source: "event:X", addedAt: "2026-01-01T00:00:00.000Z" };
  const csv = { email: "a@x.com", postcode: "M1 1AA", source: "csv:old.csv", addedAt: NOW };
  assert.equal(mergeContact(self, csv).postcode, "M1 1AA");
});

test("absence never blanks a filled field", () => {
  const existing = { email: "a@x.com", firstName: "Ada", postcode: "M1 1AA", source: "csv:a.csv", addedAt: NOW };
  const sparse = { email: "a@x.com", firstName: "Ada", source: "event:X", addedAt: NOW };
  assert.equal(mergeContact(existing, sparse).postcode, "M1 1AA");
});

test("checkout data replaces a CSV value", () => {
  const csv = { email: "a@x.com", firstName: "A.", source: "csv:old.csv", addedAt: "2026-01-01T00:00:00.000Z" };
  const self = { email: "a@x.com", firstName: "Ada", source: "event:X", addedAt: NOW };
  const out = mergeContact(csv, self);
  assert.equal(out.firstName, "Ada");
  assert.equal(out.source, "event:X");
});

test("addedAt keeps the EARLIER date", () => {
  // When they joined the audience, not when the list was last touched — a
  // re-import must not make a long-standing contact look brand new.
  const old = { email: "a@x.com", source: "csv:a.csv", addedAt: "2024-03-01T00:00:00.000Z" };
  const fresh = { email: "a@x.com", source: "event:X", addedAt: NOW };
  assert.equal(mergeContact(old, fresh).addedAt, "2024-03-01T00:00:00.000Z");
});

// ── Applying it to the list ────────────────────────────────────────────────

test("new attendees are added, known ones merged", () => {
  const existing = [{ email: "a@x.com", firstName: "A.", source: "csv:a.csv", addedAt: NOW }];
  const incoming = [
    { email: "a@x.com", firstName: "Ada", source: "event:X", addedAt: NOW },
    { email: "b@x.com", firstName: "Bo", source: "event:X", addedAt: NOW },
  ];
  const report = applyDrain(existing, incoming);
  assert.equal(report.added, 1);
  assert.equal(report.updated, 1);
  assert.equal(report.contacts.length, 2);
});

test("re-running over an unchanged list reports nothing happened", () => {
  // The organiser will press this after every event. Reporting "updated 400"
  // when nothing moved is a number they would act on.
  const incoming = [{ email: "a@x.com", firstName: "Ada", source: "event:X", addedAt: NOW }];
  const first = applyDrain([], incoming);
  const second = applyDrain(first.contacts, incoming);
  assert.equal(second.added, 0);
  assert.equal(second.updated, 0);
});

test("matching an existing contact is case-insensitive", () => {
  const existing = [{ email: "Ada@X.com", source: "csv:a.csv", addedAt: NOW }];
  const report = applyDrain(existing, [{ email: "ada@x.com", source: "event:X", addedAt: NOW }]);
  assert.equal(report.added, 0, "must not create a second record for the same person");
  assert.equal(report.contacts.length, 1);
});
