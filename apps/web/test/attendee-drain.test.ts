/**
 * Ticket buyer → marketing contact.
 *
 * Two guarantees under test, both of which a naive "newest wins" merge breaks:
 *   1. Only people with a checkout record - they ticked the opt-in, or left
 *      own-events mode's "Don't email me" alone (the soft opt-in) - are ever
 *      built into a contact. Everything else is downstream of that.
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
import { ORDER_EMAIL_FIELD_ID, type OrderField } from "@woco/shared";

const NOW = "2026-07-27T00:00:00.000Z";
const FIELDS: OrderField[] = [
  { id: "field_1", type: "text", label: "First Name", required: true, health: false },
  { id: "field_2", type: "text", label: "Surname", required: true, health: false },
  { id: "field_3", type: "text", label: "Area", required: false, health: false },
  { id: "field_4", type: "text", label: "How did you hear about us?", required: false, health: false },
  { id: "field_5", type: "text", label: "T-shirt size", required: false, health: false },
  { id: "field_6", type: "text", label: "Allergies", required: false, health: true },
  { id: ORDER_EMAIL_FIELD_ID, type: "email", label: "Email", required: true },
];
const opts = (recorded: string[], orderFields: OrderField[] = FIELDS) => ({
  orderFields,
  eventTitle: "Warehouse Project",
  eventDate: "2026-09-01",
  addedAt: NOW,
  recorded: new Set(recorded),
});

// ── Who gets built ─────────────────────────────────────────────────────────

test("only buyers with a record (consent or soft opt-in) become contacts", () => {
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

test("every non-sensitive answer is kept, each in its place - never a sensitive one, never the email field", () => {
  const out = buildAttendeeContacts(
    [{
      claimerEmail: "a@x.com",
      fields: {
        field_1: "Ada", field_2: "Lovelace", field_3: "Leeds", field_4: "Instagram", field_5: "M", field_6: "Peanuts",
        [ORDER_EMAIL_FIELD_ID]: "a@x.com",
      },
    }],
    opts(["a@x.com"]),
  );
  assert.equal(out[0].firstName, "Ada");
  assert.equal(out[0].lastName, "Lovelace");
  // Area goes to the contact's town, so the list can be searched by it.
  assert.equal(out[0].city, "Leeds");
  assert.deepEqual(out[0].answers, { "How did you hear about us?": "Instagram", "T-shirt size": "M" });
  assert.doesNotMatch(JSON.stringify(out[0]), /Peanuts|"Email"/);
});

test("a sensitive answer never moves, even when its flags arrive mislabelled", () => {
  const mislabelled = [
    // No saved flag: the label decides.
    { id: "a", type: "text", label: "Dietary requirements", required: false },
    { id: "b", type: "text", label: "Religion", required: false },
    // Doubt in an organiser-signed feed reads as sensitive.
    { id: "c", type: "text", label: "Seat preference", required: false, health: "yes" },
    { id: "d", type: "text", label: "Notes", required: false, health: null },
    // The retired key cannot bring one back.
    { id: "e", type: "text", label: "Medical conditions", required: false, health: true, keepOnList: true },
  ] as unknown as OrderField[];
  const out = buildAttendeeContacts(
    [{ claimerEmail: "a@x.com", fields: { a: "Vegan", b: "Sikh", c: "Aisle", d: "Wheelchair", e: "Asthma" } }],
    opts(["a@x.com"], mislabelled),
  );
  assert.equal(out.length, 1, "the buyer is still a contact");
  assert.equal(out[0].answers, undefined);
  assert.doesNotMatch(JSON.stringify(out[0]), /Vegan|Sikh|Aisle|Wheelchair|Asthma/);
});

test("the organiser's Not sensitive? override is honoured, and a crafted form never throws", () => {
  const overridden: OrderField[] = [{ id: "a", type: "text", label: "Diet Coke or Pepsi?", required: false, health: false }];
  const out = buildAttendeeContacts([{ claimerEmail: "a@x.com", fields: { a: "Pepsi" } }], opts(["a@x.com"], overridden));
  assert.deepEqual(out[0].answers, { "Diet Coke or Pepsi?": "Pepsi" });
  const crafted = [null, 3, { id: "x", type: "text", required: false }] as unknown as OrderField[];
  const odd = buildAttendeeContacts([{ claimerEmail: "a@x.com", fields: { x: "1" } }], opts(["a@x.com"], crafted));
  assert.equal(odd[0].answers, undefined);
});

test("an unanswered question adds nothing", () => {
  const out = buildAttendeeContacts([{ claimerEmail: "a@x.com", fields: { field_1: "  " } }], opts(["a@x.com"]));
  assert.equal(out[0].firstName, undefined);
  assert.equal(out[0].city, undefined);
  assert.equal(out[0].answers, undefined);
});

test("a single name field is kept whole rather than split", () => {
  const full: OrderField[] = [{ id: "field_9", type: "text", label: "Full name", required: true }];
  const out = buildAttendeeContacts(
    [{ claimerEmail: "a@x.com", fields: { field_9: "Ada King de Lovelace" } }],
    opts(["a@x.com"], full),
  );
  assert.equal(out[0].firstName, "Ada King de Lovelace");
  assert.equal(out[0].lastName, undefined);
});

test("kept answers merge question by question, never blanking one", () => {
  const prev = { email: "a@x.com", answers: { "How did you hear about us?": "Instagram", Genre: "Techno" }, source: "event:A", addedAt: NOW };
  const next = { email: "a@x.com", answers: { Genre: "House" }, source: "event:B", addedAt: NOW };
  assert.deepEqual(mergeContact(prev, next).answers, { "How did you hear about us?": "Instagram", Genre: "House" });
  // A lower-trust source fills a gap but never overwrites what the buyer told the organiser.
  const csv = { email: "a@x.com", answers: { Genre: "Jazz", Venue: "Leeds" }, source: "csv:old.csv", addedAt: NOW };
  assert.deepEqual(mergeContact(prev, csv).answers, { "How did you hear about us?": "Instagram", Genre: "Techno", Venue: "Leeds" });
  // An empty answer is absence, not an update.
  assert.deepEqual(mergeContact(prev, { ...next, answers: { Genre: "" } }).answers, prev.answers);
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

test("between two checkouts the later EVENT wins, whichever was read last", () => {
  // The automatic sync re-reads an older event whenever its orders change: that
  // must not turn the contact's last event (or their latest answers) back to it.
  const later = { email: "a@x.com", firstName: "Ada", lastEventName: "Autumn", lastEventDate: "2026-10-01", source: "event:Autumn", addedAt: NOW };
  const earlier = { email: "a@x.com", firstName: "A.", city: "Leeds", lastEventName: "Spring", lastEventDate: "2026-04-01", source: "event:Spring", addedAt: NOW };
  const out = mergeContact(later, earlier);
  assert.equal(out.lastEventName, "Autumn");
  assert.equal(out.lastEventDate, "2026-10-01");
  assert.equal(out.firstName, "Ada");
  assert.equal(out.source, "event:Autumn");
  assert.equal(out.city, "Leeds", "the older checkout still fills a gap");
  // And the other way round the later one takes over, as before.
  assert.equal(mergeContact(earlier, later).lastEventName, "Autumn");
  // Re-reading the older event changes nothing, so it is not counted as an update.
  assert.equal(applyDrain([out], [earlier]).updated, 0);
});

test("an unreadable event date never decides: equal rank falls to the incoming record", () => {
  const a = { email: "a@x.com", firstName: "Ada", lastEventDate: "not a date", source: "event:A", addedAt: NOW };
  const b = { email: "a@x.com", firstName: "Bo", lastEventDate: "2026-01-01", source: "event:B", addedAt: NOW };
  assert.equal(mergeContact(b, a).firstName, "Ada");
  assert.equal(mergeContact(a, b).firstName, "Bo");
});
