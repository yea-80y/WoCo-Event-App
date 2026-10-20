/**
 * "Download your list" (the contact export) and the shared CSV writer it uses
 * with the guest-list export.
 *
 * The guarantees under test:
 *   1. Every cell is RFC 4180 quoted when it needs it, so a name with a comma,
 *      quote or line break stays one cell.
 *   2. A cell a spreadsheet would run as a formula (=, +, -, @, tab, CR first)
 *      goes out with a leading ' - these cells hold text other people typed.
 *   3. The file opens with a UTF-8 BOM, so Excel shows accents.
 *   4. The columns are what the organiser sees on screen, unsubscribes marked,
 *      and nothing internal (hashes, keys, ids, our source tags).
 *   5. Re-importing the file through our own importer maps every column by
 *      itself and gives back the same contacts, minus the unsubscribed.
 *
 * MUTATIONS (each went red, then restored): FORMULA_START matching nothing, or
 * missing -, tab and CR; line breaks not quoted; quotes not doubled; the BOM
 * removed; unguardCsvCell returning its input; ANSWER_HEADER_PREFIX set to "";
 * the "Unsubscribed" label reworded so the importer no longer reads it as a no.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Papa from "papaparse";

import type { ContactConsentState, MarketingContact } from "@woco/shared";
import { buildCsv, csvCell, CSV_BOM, unguardCsvCell } from "../src/lib/utils/csv.js";
import {
  ANSWER_HEADER_PREFIX,
  buildContactsCsv,
  contactsCsvFilename,
} from "../src/lib/creator/audience/csv-export.js";
import { autoMapColumns, buildImportReport, FIELD_LABELS, IMPORT_FIELDS } from "../src/lib/creator/audience/csv-import.js";

// ── The shared cell writer ─────────────────────────────────────────────────

test("plain text goes out as it is", () => {
  assert.equal(csvCell("Ana"), "Ana");
  assert.equal(csvCell(""), "");
  assert.equal(csvCell("a=b"), "a=b", "only the FIRST character can start a formula");
});

test("commas, quotes and line breaks are quoted per RFC 4180", () => {
  assert.equal(csvCell("Smith, John"), '"Smith, John"');
  assert.equal(csvCell('Ana "AJ" Jones'), '"Ana ""AJ"" Jones"');
  assert.equal(csvCell("Flat 2\nHigh St"), '"Flat 2\nHigh St"');
  assert.equal(csvCell("Flat 2\r\nHigh St"), '"Flat 2\r\nHigh St"');
});

test("a cell a spreadsheet would run as a formula gets a leading quote", () => {
  for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
    const out = csvCell(`${lead}1+1`);
    const inner = out.startsWith('"') ? out.slice(1, -1) : out;
    assert.ok(inner.startsWith(`'${lead}`), `${JSON.stringify(lead)} must be guarded, got ${JSON.stringify(out)}`);
  }
  assert.equal(csvCell('=HYPERLINK("http://x","click")'), `"'=HYPERLINK(""http://x"",""click"")"`);
  assert.equal(csvCell("+44 7700 900123"), "'+44 7700 900123");
  assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
});

test("the guard is undone on the way back in, and only the guard", () => {
  for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
    assert.equal(unguardCsvCell(`'${lead}x`), `${lead}x`);
  }
  assert.equal(unguardCsvCell("'Brien"), "'Brien", "an apostrophe that is not our guard stays");
  assert.equal(unguardCsvCell("O'Brien"), "O'Brien");
});

test("a file starts with the UTF-8 BOM and ends rows with CRLF", () => {
  const csv = buildCsv([["Name"], ["Zoë"]]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.startsWith(CSV_BOM));
  assert.equal(csv, "﻿Name\r\nZoë\r\n");
});

// ── The contact export ─────────────────────────────────────────────────────

const STATES: Record<string, ContactConsentState> = {
  "ana@example.com": "opted-in",
  "bo@example.com": "soft-opt-in",
  "cy@example.com": "imported",
  "di@example.com": "unsubscribed",
};
const consentOf = (email: string): ContactConsentState => STATES[email] ?? "imported";

const CONTACTS: MarketingContact[] = [
  {
    email: "ana@example.com",
    firstName: "Zoë",
    lastName: "O'Brien, Jr",
    phone: "+44 7700 900123",
    address1: "Flat 2\nThe Old Bakery",
    address2: 'The "Annex"',
    postcode: "M1 1AA",
    city: "Manchester",
    country: "United Kingdom",
    dob: "01/02/1990",
    tags: "vip; regular",
    lastEventName: "=cmd|'/C calc'!A0",
    lastEventDate: "2026-09-01",
    ticketsBought: "4",
    totalSpend: "£48.00",
    answers: { "Dietary needs": "Vegan", "Email address": "other@example.com" },
    source: "event:Autumn Social",
    addedAt: "2026-09-02T10:11:12.000Z",
  },
  { email: "bo@example.com", firstName: "Bo", source: "csv:old-platform.csv", addedAt: "2026-08-01T00:00:00.000Z" },
  {
    email: "cy@example.com",
    lastName: "-",
    answers: { "Plus one": "Yes" },
    addedAt: "2026-07-01T00:00:00.000Z",
  },
  { email: "di@example.com", firstName: "Di", addedAt: "2026-06-01T00:00:00.000Z" },
];

function parse(csv: string) {
  const res = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
  assert.deepEqual(res.errors, []);
  return { headers: res.meta.fields ?? [], rows: res.data };
}

test("the columns are the importer's labels, then source, date and booking answers", () => {
  const { headers } = parse(buildContactsCsv(CONTACTS, consentOf));
  assert.deepEqual(headers, [
    "Email",
    "First name",
    "Last name",
    "Marketing consent",
    "Phone",
    "Address line 1",
    "Address line 2",
    "Town / city",
    "Postcode",
    "Country",
    "Date of birth",
    "Tags",
    "Last event",
    "Last event date",
    "Tickets bought",
    "Total spend",
    "Source",
    "Added on",
    `${ANSWER_HEADER_PREFIX}Dietary needs`,
    `${ANSWER_HEADER_PREFIX}Email address`,
    `${ANSWER_HEADER_PREFIX}Plus one`,
  ]);
});

test("each contact's row says what the screen shows, unsubscribes included", () => {
  const { rows } = parse(buildContactsCsv(CONTACTS, consentOf));
  assert.equal(rows.length, CONTACTS.length, "every contact, unsubscribed ones too");
  assert.deepEqual(
    rows.map((r) => r["Marketing consent"]),
    ["Opted in", "Didn't opt out", "Imported", "Unsubscribed"],
  );
  const [ana, bo, cy] = rows;
  assert.equal(ana["First name"], "Zoë");
  assert.equal(ana["Last name"], "O'Brien, Jr");
  assert.equal(ana["Address line 1"], "Flat 2\nThe Old Bakery");
  assert.equal(ana["Address line 2"], 'The "Annex"');
  assert.equal(ana["Phone"], "'+44 7700 900123", "guarded for the spreadsheet");
  assert.equal(ana["Last event"], "'=cmd|'/C calc'!A0");
  assert.equal(ana["Source"], "Ticket buyer at Autumn Social");
  assert.equal(ana["Added on"], "2026-09-02");
  assert.equal(ana[`${ANSWER_HEADER_PREFIX}Dietary needs`], "Vegan");
  assert.equal(bo["Source"], "Imported from old-platform.csv");
  assert.equal(bo[`${ANSWER_HEADER_PREFIX}Dietary needs`], "", "an answer they never gave is blank");
  assert.equal(cy["Last name"], "'-");
  assert.equal(cy["Source"], "");
});

test("nothing internal goes out: no source tags, no hashes, no ids", () => {
  const csv = buildContactsCsv(CONTACTS, consentOf);
  assert.doesNotMatch(csv, /\bcsv:|\bevent:/);
  assert.doesNotMatch(csv, /[0-9a-f]{40,}/i);
  assert.doesNotMatch(csv, /\b(hash|seriesId|eventId|swarmRef)\b/i);
});

test("re-importing the export maps every column by itself", () => {
  const { headers } = parse(buildContactsCsv(CONTACTS, consentOf));
  const mapping = autoMapColumns(headers);
  for (const field of IMPORT_FIELDS) {
    if (field === "fullName") assert.equal(mapping.fullName, "");
    else assert.equal(mapping[field], FIELD_LABELS[field], `${field} should map to its own column`);
  }
});

test("a booking answer labelled like one of our fields cannot take that field", () => {
  // Bare, these labels outscore our own headers in the importer's guess ("Email
  // address" beats "Email", "Mobile number" beats "Phone"), so the prefix is load-bearing.
  const answers = { "Email address": "x@example.com", "Mobile number": "1", Telephone: "2", Postcode: "Z" };
  const { headers } = parse(buildContactsCsv([{ email: "a@example.com", answers, addedAt: "2026-01-01" }], consentOf));
  const mapping = autoMapColumns(headers);
  assert.equal(mapping.email, "Email");
  assert.equal(mapping.phone, "Phone");
  assert.equal(mapping.postcode, "Postcode");
});

test("the round trip gives back the same contacts, without the unsubscribed", () => {
  const { headers, rows } = parse(buildContactsCsv(CONTACTS, consentOf));
  const report = buildImportReport(rows, autoMapColumns(headers), new Set(), {
    source: "csv:woco-contacts-2026-10-20.csv",
    addedAt: "2026-10-20T00:00:00.000Z",
  });
  assert.equal(report.invalidRows, 0);
  assert.equal(report.declinedConsent, 1, "the unsubscribed row is read as a refusal");
  assert.deepEqual(
    report.candidates.map((c) => c.email),
    ["ana@example.com", "bo@example.com", "cy@example.com"],
  );
  const FIELDS = [
    "firstName", "lastName", "phone", "address1", "address2", "postcode", "city", "country",
    "dob", "tags", "lastEventName", "lastEventDate", "ticketsBought", "totalSpend",
  ] as const;
  for (const back of report.candidates) {
    const original = CONTACTS.find((c) => c.email === back.email)!;
    for (const f of FIELDS) assert.equal(back[f], original[f], `${back.email} ${f}`);
  }
});

test("the filename is woco-contacts-YYYY-MM-DD.csv on the local day", () => {
  assert.equal(contactsCsvFilename(new Date(2026, 0, 5, 23, 59)), "woco-contacts-2026-01-05.csv");
  assert.equal(contactsCsvFilename(new Date(2026, 9, 20)), "woco-contacts-2026-10-20.csv");
});
