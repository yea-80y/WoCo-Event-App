/**
 * CSV import at real list scale.
 *
 * The unit tests in csv-import.test.ts prove the RULES on handfuls of rows.
 * This proves the pipeline survives a full-size export end to end — automap →
 * per-column samples → manifest → seal → reopen — because the failures that only
 * appear at scale are different ones: a sealed blob over the server cap, a
 * per-column scan that is accidentally O(rows × columns) on every render, and
 * bucket arithmetic that drifts once duplicates and refusals overlap.
 *
 * 20k is `MARKETING_MAX_LIST_EMAILS` — the largest list the platform will store,
 * so it is the case that has to work, not a stress test beyond the contract.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  sealJsonCompressed,
  openJsonAuto,
  deriveEncryptionKeypairFromPodSeed,
  MARKETING_MAX_LIST_EMAILS,
} from "@woco/shared";
import {
  autoMapColumns,
  buildImportReport,
  sampleValues,
  invertMapping,
} from "../src/lib/creator/audience/csv-import.js";

/** Mirrors MAX_SEALED_JSON in apps/server/src/routes/marketing.ts. */
const MAX_SEALED_JSON = 6_000_000;

/** A wide export: every field we map, plus columns we deliberately ignore. */
const HEADERS = [
  "Email Address", "First Name", "Last Name", "Mobile Number", "Postcode",
  "Town/City", "Country", "Date of Birth", "Marketing Opt In", "Tags",
  "Last Event Attended", "Last Event Date", "Tickets Purchased", "Total Spend",
  "Order ID", "Email Verified",
];

const FIRST = ["James", "Sarah", "Mohammed", "Aoife", "Oliver", "Chloe", "Daniel", "Priya", "Liam", "Emma"];
const LAST = ["Smith", "Jones", "Patel", "O'Connor", "Brown", "Wilson", "Taylor", "Ahmed", "Davies", "Evans"];
const DOMAINS = ["gmail.com", "hotmail.co.uk", "outlook.com", "yahoo.co.uk", "icloud.com"];
const CITIES = ["Manchester", "Leeds", "Bristol", "Glasgow", "Sheffield", "Nottingham"];

function makeRows(n: number): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (let i = 0; i < n; i++) {
    const f = FIRST[i % FIRST.length];
    const l = LAST[i % LAST.length];
    out.push({
      // Every 97th row is unparseable — real exports always carry some.
      "Email Address": i % 97 === 0
        ? "not-an-email"
        : `${f.toLowerCase()}.${l.toLowerCase().replace(/'/g, "")}${i}@${DOMAINS[i % DOMAINS.length]}`,
      "First Name": f,
      "Last Name": l,
      "Mobile Number": `07700 9${String(100000 + (i % 899999))}`,
      "Postcode": `M${(i % 40) + 1} ${(i % 9) + 1}AA`,
      "Town/City": CITIES[i % CITIES.length],
      "Country": "United Kingdom",
      "Date of Birth": `${(i % 28) + 1}/${(i % 12) + 1}/19${70 + (i % 30)}`,
      "Marketing Opt In": i % 11 === 0 ? "No" : "Yes",
      "Tags": i % 6 === 0 ? "vip,early-bird" : "",
      "Last Event Attended": `Warehouse Project ${CITIES[i % CITIES.length]}`,
      "Last Event Date": `2026-0${(i % 9) + 1}-1${i % 10}`,
      "Tickets Purchased": String((i % 12) + 1),
      "Total Spend": `${(i % 400) + 20}.00`,
      "Order ID": `ORD-${100000 + i}`,
      "Email Verified": "true",
    });
  }
  // Re-append a slice so in-file duplicates overlap the refusals and the invalids.
  for (let i = 0; i < Math.floor(n / 50); i++) out.push({ ...out[i] });
  return out;
}

for (const n of [1_000, 5_000, MARKETING_MAX_LIST_EMAILS]) {
  test(`the import pipeline handles ${n.toLocaleString()} contacts`, async () => {
    const rows = makeRows(n);

    const mapping = autoMapColumns(HEADERS);
    assert.equal(mapping.email, "Email Address");
    assert.equal(mapping.consent, "Marketing Opt In");
    assert.equal(mapping.lastName, "Last Name", "'Last Event Attended' must not steal the surname");
    assert.equal(mapping.country, "Country");

    // The mapping UI derives these for every column on every render.
    const started = performance.now();
    for (const header of HEADERS) sampleValues(rows, header);
    invertMapping(mapping);
    const sampleMs = performance.now() - started;
    assert.ok(sampleMs < 250, `per-column samples must stay cheap, took ${sampleMs.toFixed(0)}ms`);

    // A fifth of the file is already in the stored list.
    const existing = new Set(
      rows.slice(0, Math.floor(n / 20)).map((r) => r["Email Address"].toLowerCase()),
    );
    const report = buildImportReport(rows, mapping, existing, {
      source: "csv:scale.csv",
      addedAt: "2026-07-27T00:00:00.000Z",
    });

    const accounted =
      report.candidates.length +
      report.invalidRows +
      report.dupesInFile +
      report.dupesVsList +
      report.declinedConsent;
    assert.equal(accounted, rows.length, "the manifest must account for the whole file");
    assert.ok(report.declinedConsent > 0, "the consent gate must have excluded rows");
    assert.ok(report.invalidRows > 0, "the invalid rows must be caught");
    assert.ok(report.dupesVsList > 0, "the stored-list dedupe must fire");

    // Seal exactly what AudienceScreen.commitList seals, with the same key derivation.
    const keys = deriveEncryptionKeypairFromPodSeed("11".repeat(32));
    const sealed = await sealJsonCompressed(keys.publicKey, {
      version: 1,
      contacts: report.candidates,
    });
    const sealedBytes = JSON.stringify(sealed).length;
    assert.ok(
      sealedBytes < MAX_SEALED_JSON,
      `sealed blob ${(sealedBytes / 1e6).toFixed(2)}MB must fit the ${MAX_SEALED_JSON / 1e6}MB cap`,
    );

    const reopened = await openJsonAuto<{ contacts: unknown[] }>(keys.privateKey, sealed);
    assert.equal(reopened.contacts.length, report.candidates.length, "round-trip must be lossless");
    // Unset optional fields are dropped by JSON, not carried as `undefined` keys —
    // that is the intended shape (it is what keeps the blob small), so compare
    // against the serialised original rather than the in-memory one.
    assert.deepEqual(
      reopened.contacts[0],
      JSON.parse(JSON.stringify(report.candidates[0])),
    );
  });
}
