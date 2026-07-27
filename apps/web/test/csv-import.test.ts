/**
 * CSV contact-import: header guessing + the import manifest.
 *
 * Why this matters: organisers upload lists exported from Skiddle, Fatsoma, RA,
 * Eventbrite and assorted box-office systems. None of those publish a column
 * schema (RA lets the promoter pick which fields to include, so it has no fixed
 * shape at all), so the fixtures below are REPRESENTATIVE, not authoritative —
 * they encode the header conventions those exports plausibly use, plus the
 * spreadsheet mangling that reliably happens on the way.
 *
 * The guarantees under test:
 *   1. A plausible export auto-maps without human help, and a header that names
 *      a FLAG ("Email Opt In") is never mistaken for the address itself.
 *   2. Every row lands in exactly one manifest bucket — the tallies shown to the
 *      organiser account for the whole file.
 *   3. Suppression/dedupe inputs are compared on the NORMALISED address, so
 *      "Bob@X.COM " cannot slip past a list that already holds "bob@x.com".
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  autoMapColumns,
  buildImportReport,
  normaliseEmail,
  emptyMapping,
  type ColumnMapping,
} from "../src/lib/creator/audience/csv-import.js";

const OPTS = { source: "csv:test.csv", addedAt: "2026-07-27T00:00:00.000Z" };

function mapped(partial: Partial<ColumnMapping>): ColumnMapping {
  return { ...emptyMapping(), ...partial };
}

// ── Header auto-mapping ────────────────────────────────────────────────────

test("auto-maps a conventional UK ticketing export", () => {
  const m = autoMapColumns(["First Name", "Last Name", "Email Address", "Postcode", "Date of Birth"]);
  assert.equal(m.email, "Email Address");
  assert.equal(m.firstName, "First Name");
  assert.equal(m.lastName, "Last Name");
  assert.equal(m.postcode, "Postcode");
  assert.equal(m.dob, "Date of Birth");
});

test("auto-maps snake_case and mixed separators", () => {
  const m = autoMapColumns(["email_address", "first_name", "last_name", "post_code", "dob"]);
  assert.equal(m.email, "email_address");
  assert.equal(m.firstName, "first_name");
  assert.equal(m.lastName, "last_name");
  assert.equal(m.postcode, "post_code");
  assert.equal(m.dob, "dob");
});

test("auto-maps US-style headers", () => {
  const m = autoMapColumns(["Email", "Given Name", "Surname", "Zip Code", "Birthday"]);
  assert.equal(m.email, "Email");
  assert.equal(m.firstName, "Given Name");
  assert.equal(m.lastName, "Surname");
  assert.equal(m.postcode, "Zip Code");
  assert.equal(m.dob, "Birthday");
});

test("finds a prefixed email column the old exact-match heuristic missed", () => {
  // The regression that motivated the scoring rewrite: /^e-?mail(address)?$/
  // matched none of these, so the organiser hit a blocked Continue button.
  for (const header of ["Buyer Email", "Customer Email", "Attendee Email", "Contact E-Mail"]) {
    assert.equal(autoMapColumns([header, "First Name"]).email, header, header);
  }
});

test("prefers the exact email column when several are present", () => {
  const m = autoMapColumns(["Billing Email", "Email", "Backup Email"]);
  assert.equal(m.email, "Email");
});

test("never maps a consent FLAG as the email address", () => {
  // Importing "Yes"/"true" as addresses would poison the list wholesale.
  const m = autoMapColumns(["Email Opt In", "Email Verified", "Marketing Email Consent"]);
  assert.equal(m.email, "", "no column here holds an address");
});

test("a flag column does not shadow the real address column", () => {
  const m = autoMapColumns(["Email Opt In", "Buyer Email"]);
  assert.equal(m.email, "Buyer Email");
});

test("leaves fields absent from the file unmapped", () => {
  const m = autoMapColumns(["Email", "Order Reference", "Ticket Type", "Quantity"]);
  assert.equal(m.email, "Email");
  assert.equal(m.firstName, "");
  assert.equal(m.lastName, "");
  assert.equal(m.postcode, "");
  assert.equal(m.dob, "");
});

test("one header is never claimed by two fields", () => {
  const m = autoMapColumns(["Name", "Email"]);
  const claimed = [m.email, m.firstName, m.lastName, m.postcode, m.dob].filter(Boolean);
  assert.equal(new Set(claimed).size, claimed.length);
});

test("mapping is deterministic for a given file", () => {
  const headers = ["Email", "Billing Email", "First Name", "Attendee First Name", "Postcode"];
  assert.deepEqual(autoMapColumns(headers), autoMapColumns(headers));
});

// ── Email normalisation ────────────────────────────────────────────────────

test("normalises the address shapes real exports contain", () => {
  assert.equal(normaliseEmail("  Bob@Example.COM "), "bob@example.com");
  assert.equal(normaliseEmail('"Bob Smith" <bob@example.com>'), "bob@example.com");
  assert.equal(normaliseEmail("mailto:bob@example.com"), "bob@example.com");
  assert.equal(normaliseEmail('"bob@example.com"'), "bob@example.com");
});

test("does not guess when a cell holds two addresses", () => {
  const report = buildImportReport(
    [{ Email: "a@x.com; b@y.com" }],
    mapped({ email: "Email" }),
    new Set(),
    OPTS,
  );
  assert.equal(report.candidates.length, 0);
  assert.equal(report.invalidRows, 1);
});

// ── Import manifest ────────────────────────────────────────────────────────

test("every row lands in exactly one bucket", () => {
  const rows = [
    { Email: "new@x.com" },
    { Email: "also-new@x.com" },
    { Email: "NEW@x.com" }, // dupe of row 1, different case
    { Email: "existing@x.com" }, // already in the audience
    { Email: "not an email" },
    { Email: "" }, // blank cell
  ];
  const report = buildImportReport(
    rows,
    mapped({ email: "Email" }),
    new Set(["existing@x.com"]),
    OPTS,
  );

  assert.equal(report.candidates.length, 2);
  assert.equal(report.dupesInFile, 1);
  assert.equal(report.dupesVsList, 1);
  assert.equal(report.invalidRows, 2);

  const accounted =
    report.candidates.length + report.dupesInFile + report.dupesVsList + report.invalidRows;
  assert.equal(accounted, rows.length, "the manifest must account for the whole file");
});

test("de-dupes against the existing list case-insensitively", () => {
  const report = buildImportReport(
    [{ Email: " Existing@X.com " }],
    mapped({ email: "Email" }),
    new Set(["existing@x.com"]),
    OPTS,
  );
  assert.equal(report.candidates.length, 0, "a case variant must not create a duplicate contact");
  assert.equal(report.dupesVsList, 1);
});

test("carries the mapped optional fields through, trimmed", () => {
  const report = buildImportReport(
    [{ E: "bob@x.com", F: " Bob ", L: " Smith ", P: " M1 1AA ", D: " 12/03/1990 " }],
    mapped({ email: "E", firstName: "F", lastName: "L", postcode: "P", dob: "D" }),
    new Set(),
    OPTS,
  );
  assert.deepEqual(report.candidates[0], {
    email: "bob@x.com",
    firstName: "Bob",
    lastName: "Smith",
    postcode: "M1 1AA",
    // Verbatim: 12/03/1990 is unknowable as DD/MM or MM/DD, so it is not reformatted.
    dob: "12/03/1990",
    source: OPTS.source,
    addedAt: OPTS.addedAt,
  });
});

test("unmapped and empty optional fields become undefined, not empty strings", () => {
  const report = buildImportReport(
    [{ E: "bob@x.com", F: "   " }],
    mapped({ email: "E", firstName: "F" }),
    new Set(),
    OPTS,
  );
  const contact = report.candidates[0];
  assert.equal(contact.firstName, undefined);
  assert.equal(contact.lastName, undefined);
  assert.equal(contact.postcode, undefined);
});

test("a row missing the mapped column entirely is invalid, not a crash", () => {
  const report = buildImportReport(
    [{ Other: "x" }],
    mapped({ email: "Email" }),
    new Set(),
    OPTS,
  );
  assert.equal(report.invalidRows, 1);
});

test("an empty file produces an empty manifest", () => {
  const report = buildImportReport([], mapped({ email: "Email" }), new Set(), OPTS);
  assert.deepEqual(report, { candidates: [], invalidRows: 0, dupesInFile: 0, dupesVsList: 0 });
});
