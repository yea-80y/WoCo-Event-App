/**
 * CSV contact-import logic — pure, so it can be tested without a DOM.
 *
 * Organisers arrive with exports from Skiddle, Fatsoma, RA, Eventbrite and a
 * dozen box-office systems. NONE of them publish a column schema, and RA lets
 * the promoter tick which fields to include, so there is no fixed shape to code
 * against. `autoMapColumns` therefore guesses and the wizard ALWAYS shows the
 * mapping dropdowns for a human to correct — the guess is a convenience, never
 * a contract.
 */

import type { MarketingContact } from "@woco/shared";

export type ImportField = "email" | "firstName" | "lastName" | "postcode" | "dob";

export const IMPORT_FIELDS: ImportField[] = ["email", "firstName", "lastName", "postcode", "dob"];

/** field → source header name; "" means "not present in this file". */
export type ColumnMapping = Record<ImportField, string>;

export function emptyMapping(): ColumnMapping {
  return { email: "", firstName: "", lastName: "", postcode: "", dob: "" };
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Canonical tokens per field, most-specific first. A header scores by how
 * closely it matches one: exact beats suffix ("Billing Postcode") beats
 * anywhere-in-the-string.
 */
const FIELD_TOKENS: Record<ImportField, string[]> = {
  email: ["emailaddress", "email", "emailaddr", "mail"],
  firstName: ["firstname", "givenname", "forename", "christianname", "first", "given"],
  lastName: ["lastname", "surname", "familyname", "last", "family"],
  postcode: ["postcode", "postalcode", "zipcode", "postal", "zip"],
  dob: ["dateofbirth", "birthdate", "birthday", "dob", "born"],
};

/**
 * Headers that contain a field token but hold a flag or a derived value rather
 * than the value itself — "Email Opt In", "Email Verified", "Surname Initial".
 * Mapping one of these would silently import booleans as email addresses.
 *
 * Deliberately NOT listed: "id". "Email ID" means the actual address in plenty
 * of real exports.
 */
const DECOY_RE =
  /(optin|optout|unsub|subscrib|consent|marketing|verified|confirmed|hash|status|preference|initial|count|permission)/;

function normHeader(h: string): string {
  return h.toLowerCase().replace(/[\s_.\-()[\]/]/g, "");
}

function scoreHeader(normalised: string, tokens: string[]): number {
  if (!normalised || DECOY_RE.test(normalised)) return 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!normalised.includes(token)) continue;
    // Earlier tokens are more specific, so they outrank later ones at equal shape.
    const specificity = tokens.length - i;
    if (normalised === token) return 300 + specificity;
    if (normalised.endsWith(token)) return 200 + specificity;
    return 100 + specificity;
  }
  return 0;
}

/**
 * Best-effort header → field guess. Greedy by score: each header is claimed by
 * at most one field, so a file with both "Email" and "Billing Email" maps the
 * exact one and leaves the other for the organiser to override.
 */
export function autoMapColumns(headers: string[]): ColumnMapping {
  const mapping = emptyMapping();

  const scored: Array<{ field: ImportField; header: string; score: number }> = [];
  for (const field of IMPORT_FIELDS) {
    for (const header of headers) {
      const score = scoreHeader(normHeader(header), FIELD_TOKENS[field]);
      if (score > 0) scored.push({ field, header, score });
    }
  }
  // Ties resolve by field order then header order — deterministic for a given file.
  scored.sort((a, b) => b.score - a.score);

  const takenHeaders = new Set<string>();
  for (const { field, header } of scored) {
    if (mapping[field] || takenHeaders.has(header)) continue;
    mapping[field] = header;
    takenHeaders.add(header);
  }
  return mapping;
}

/**
 * Coax a bare address out of a cell. Handles the shapes that appear in real
 * exports — `"Bob" <bob@x.com>`, `mailto:`, stray quotes, mixed case. Anything
 * still ambiguous (two addresses in one cell) is left alone and counted invalid
 * rather than guessed at.
 */
export function normaliseEmail(raw: string): string {
  let value = raw.trim();
  const angled = /<([^>]+)>/.exec(value);
  if (angled) value = angled[1];
  value = value.trim().replace(/^["']|["']$/g, "");
  if (/^mailto:/i.test(value)) value = value.slice(7);
  return value.trim().toLowerCase();
}

export interface ImportReport {
  /** Valid, de-duplicated, not-already-in-the-list contacts, ready to add */
  candidates: MarketingContact[];
  invalidRows: number;
  dupesInFile: number;
  dupesVsList: number;
}

export interface BuildReportOptions {
  source: string;
  addedAt: string;
}

/**
 * Turn parsed CSV rows into the import manifest. Every row lands in exactly one
 * bucket — the tallies the organiser sees must account for the whole file.
 */
export function buildImportReport(
  rows: Array<Record<string, string>>,
  mapping: ColumnMapping,
  existingEmails: Set<string>,
  { source, addedAt }: BuildReportOptions,
): ImportReport {
  const candidates: MarketingContact[] = [];
  const seen = new Set<string>();
  let invalidRows = 0;
  let dupesInFile = 0;
  let dupesVsList = 0;

  for (const row of rows) {
    const email = normaliseEmail(row[mapping.email] ?? "");
    if (!EMAIL_RE.test(email)) {
      invalidRows++;
      continue;
    }
    if (seen.has(email)) {
      dupesInFile++;
      continue;
    }
    seen.add(email);
    if (existingEmails.has(email)) {
      dupesVsList++;
      continue;
    }
    const pick = (field: ImportField): string | undefined =>
      mapping[field] ? (row[mapping[field]] ?? "").trim() || undefined : undefined;

    candidates.push({
      email,
      firstName: pick("firstName"),
      lastName: pick("lastName"),
      postcode: pick("postcode"),
      dob: pick("dob"),
      source,
      addedAt,
    });
  }

  return { candidates, invalidRows, dupesInFile, dupesVsList };
}
