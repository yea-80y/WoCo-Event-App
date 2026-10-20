/**
 * "Download your list" - the contact list as a CSV the organiser can keep or
 * take to another platform. Pure, so it can be tested without a DOM.
 *
 * Built only from what the Audience screen already holds in plaintext: the
 * opened list and the consent states it shows. No hashes, keys or ids.
 *
 * The headers are the import wizard's own field labels, so a file exported here
 * maps itself column for column when it is imported again.
 */

import type { ContactConsentState, MarketingContact } from "@woco/shared";
import { buildCsv } from "../../utils/csv.js";
import { FIELD_GROUPS, FIELD_LABELS, type ImportField } from "./csv-import.js";

/**
 * Column order = the import's mapping screen order. `fullName` is left out: the
 * file always has the first/last pair, which the importer prefers anyway.
 */
const FIELD_COLUMNS: Array<Exclude<ImportField, "fullName">> = FIELD_GROUPS.flatMap((g) => g.fields).filter(
  (f): f is Exclude<ImportField, "fullName"> => f !== "fullName",
);

/**
 * The words the Audience screen shows for each state. "Unsubscribed" is also a
 * word the importer reads as a refusal, so re-importing this file never adds an
 * unsubscribed person back.
 */
export const CONSENT_EXPORT_LABELS: Record<ContactConsentState, string> = {
  "opted-in": "Opted in",
  "soft-opt-in": "Didn't opt out",
  imported: "Imported",
  unsubscribed: "Unsubscribed",
};

/**
 * Kept order-form answers go under their question's label, prefixed. A bare
 * label like "Email address" would otherwise outscore our own "Email" column in
 * the importer's header guess and take its place.
 */
export const ANSWER_HEADER_PREFIX = "Booking answer: ";

export const SOURCE_HEADER = "Source";
export const ADDED_HEADER = "Added on";

/** Where a contact came from, in words rather than our internal tags. */
function sourceLabel(source: string | undefined): string {
  if (!source) return "";
  if (source.startsWith("csv:")) return `Imported from ${source.slice(4)}`;
  if (source.startsWith("event:")) return `Ticket buyer at ${source.slice(6)}`;
  return source;
}

/** The day they joined, as YYYY-MM-DD: unambiguous in any spreadsheet or locale. */
function addedOn(addedAt: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(addedAt) ? addedAt.slice(0, 10) : addedAt;
}

/**
 * The whole list as CSV text (BOM included). `consentOf` is the screen's own
 * state lookup, so the file says what the organiser sees, unsubscribes included.
 */
export function buildContactsCsv(
  contacts: readonly MarketingContact[],
  consentOf: (email: string) => ContactConsentState,
): string {
  // Every label any contact has, in first-seen order: that follows the order-form order.
  const answerLabels: string[] = [];
  const seen = new Set<string>();
  for (const c of contacts) {
    for (const label of Object.keys(c.answers ?? {})) {
      if (!seen.has(label)) {
        seen.add(label);
        answerLabels.push(label);
      }
    }
  }

  const header = [
    ...FIELD_COLUMNS.map((f) => FIELD_LABELS[f]),
    SOURCE_HEADER,
    ADDED_HEADER,
    ...answerLabels.map((label) => ANSWER_HEADER_PREFIX + label),
  ];

  // String() on every value: one malformed field must not cost the organiser the whole download.
  const rows = contacts.map((c) => [
    ...FIELD_COLUMNS.map((f) => (f === "consent" ? CONSENT_EXPORT_LABELS[consentOf(c.email)] : String(c[f] ?? ""))),
    sourceLabel(c.source),
    addedOn(String(c.addedAt ?? "")),
    ...answerLabels.map((label) => String(c.answers?.[label] ?? "")),
  ]);

  return buildCsv([header, ...rows]);
}

/** `woco-contacts-YYYY-MM-DD.csv`, on the organiser's own calendar day. */
export function contactsCsvFilename(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `woco-contacts-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.csv`;
}
