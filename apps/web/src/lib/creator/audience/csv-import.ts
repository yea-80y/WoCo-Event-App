/**
 * CSV contact-import logic — pure, so it can be tested without a DOM.
 *
 * Organisers arrive with exports from Skiddle, Fatsoma, RA, Eventbrite and a
 * dozen box-office systems. NONE of them publish a column schema, and RA lets
 * the promoter tick which fields to include, so there is no fixed shape to code
 * against. `autoMapColumns` therefore guesses and the wizard ALWAYS lets a human
 * correct it — the guess is a convenience, never a contract.
 */

import type { MarketingContact } from "@woco/shared";

/**
 * Fields that can be mapped to a CSV column.
 *
 * `fullName` is a MAPPING-ONLY pseudo-field: it never reaches MarketingContact,
 * it splits into firstName/lastName at build time. Plenty of exports carry one
 * "Name" column and nothing else.
 */
export type ImportField =
  | "email"
  | "firstName"
  | "lastName"
  | "fullName"
  | "phone"
  | "address1"
  | "address2"
  | "postcode"
  | "city"
  | "country"
  | "dob"
  | "consent"
  | "tags"
  | "lastEventName"
  | "lastEventDate"
  | "ticketsBought"
  | "totalSpend";

export const IMPORT_FIELDS: ImportField[] = [
  "email",
  "firstName",
  "lastName",
  "fullName",
  "phone",
  "address1",
  "address2",
  "postcode",
  "city",
  "country",
  "dob",
  "consent",
  "tags",
  "lastEventName",
  "lastEventDate",
  "ticketsBought",
  "totalSpend",
];

/** Presentation grouping — the mapping UI renders in this order. */
export interface FieldGroup {
  id: string;
  label: string;
  fields: ImportField[];
}

export const FIELD_GROUPS: FieldGroup[] = [
  { id: "identity", label: "Who they are", fields: ["email", "firstName", "lastName", "fullName"] },
  { id: "consent", label: "Consent", fields: ["consent"] },
  // Postal order — the group reads as an address block once the street lines are in it.
  { id: "contact", label: "Contact & location", fields: ["phone", "address1", "address2", "city", "postcode", "country"] },
  { id: "history", label: "History with you", fields: ["dob", "tags", "lastEventName", "lastEventDate", "ticketsBought", "totalSpend"] },
];

export const FIELD_LABELS: Record<ImportField, string> = {
  email: "Email",
  firstName: "First name",
  lastName: "Last name",
  fullName: "Full name",
  phone: "Phone",
  address1: "Address line 1",
  address2: "Address line 2",
  postcode: "Postcode",
  city: "Town / city",
  country: "Country",
  dob: "Date of birth",
  consent: "Marketing consent",
  tags: "Tags",
  lastEventName: "Last event",
  lastEventDate: "Last event date",
  ticketsBought: "Tickets bought",
  totalSpend: "Total spend",
};

/** Short "why you'd want this" copy for the mapping UI. */
export const FIELD_HINTS: Partial<Record<ImportField, string>> = {
  email: "Required — where the email goes",
  fullName: "Split into first and last automatically",
  consent: "Rows marked 'no' are excluded from the import",
  address1: "One combined address column goes here whole",
  postcode: "Useful for targeting by area",
  lastEventName: "Useful for 'you came to X' campaigns",
};

/** field → source header name; "" means "not present in this file". */
export type ColumnMapping = Record<ImportField, string>;

export function emptyMapping(): ColumnMapping {
  return Object.fromEntries(IMPORT_FIELDS.map((f) => [f, ""])) as ColumnMapping;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Headers that contain a field token but hold a flag or a derived value rather
 * than the value itself — "Email Opt In", "Email Verified", "Surname Initial".
 * Mapping one of these would silently import booleans as email addresses.
 *
 * Deliberately NOT listed: "id". "Email ID" means the actual address in plenty
 * of real exports.
 *
 * The `consent` field is EXEMPT — a consent column is supposed to look like a
 * flag, so it carries its own tokens and its own narrow decoy guard below.
 */
// `count(?!ry)`: separators are stripped before matching, so a bare `count`
// would also reject "Country".
const DECOY_RE =
  /(optin|optout|unsub|subscrib|consent|marketing|verified|confirmed|hash|status|preference|initial|count(?!ry)|permission)/;

interface FieldSpec {
  /** Canonical tokens, most-specific first. */
  tokens: string[];
  /** Extra per-field decoy guard, applied on top of (or instead of) DECOY_RE. */
  decoy?: RegExp;
  /** Opt out of the shared DECOY_RE — only `consent`, which wants flag headers. */
  ignoreSharedDecoy?: boolean;
}

/**
 * A header scores by how closely it matches a token: exact beats suffix
 * ("Billing Postcode") beats anywhere-in-the-string.
 */
const FIELD_SPECS: Record<ImportField, FieldSpec> = {
  email: { tokens: ["emailaddress", "email", "emailaddr", "mail"] },
  // "Last Event Name" contains "last"; without this guard a file with event
  // history but no surname column would import event titles as people's names.
  firstName: {
    tokens: ["firstname", "givenname", "forename", "christianname", "first", "given"],
    decoy: /event|ticket|order|purchase/,
  },
  lastName: {
    tokens: ["lastname", "surname", "familyname", "last", "family"],
    decoy: /event|ticket|order|purchase|login|seen|active/,
  },
  fullName: {
    tokens: ["fullname", "customername", "attendeename", "contactname", "displayname", "name"],
    decoy: /event|ticket|order|company|organisation|organization|venue|file|user|first|last|sur|given/,
  },
  phone: {
    tokens: ["mobilenumber", "phonenumber", "telephone", "mobile", "phone", "tel", "contactnumber"],
  },
  // "Email Address" normalises to "emailaddress", which CONTAINS the "address"
  // token. `email` outscores it today (exact match, 304 vs 10x), but relying on
  // that margin means a rename to "Contact Address (email)" quietly imports
  // addresses as street lines. The guard makes it explicit instead.
  address1: {
    tokens: ["addressline1", "streetaddress", "billingaddress", "addressline", "address1", "addr1", "address", "street", "addr"],
    decoy: /email|mail|ip$|url|web|wallet|eth|type|book|[23]$/,
  },
  address2: {
    tokens: ["addressline2", "address2", "addr2"],
    decoy: /email|mail|url|web|wallet|eth|type/,
  },
  postcode: { tokens: ["postcode", "postalcode", "zipcode", "postal", "zip"] },
  city: { tokens: ["towncity", "city", "town", "locality"] },
  country: { tokens: ["country", "nation"] },
  dob: { tokens: ["dateofbirth", "birthdate", "birthday", "dob", "born"] },
  consent: {
    tokens: [
      "marketingoptin",
      "marketingconsent",
      "emailoptin",
      "emailconsent",
      "marketingpermission",
      "optin",
      "consent",
      "subscribed",
      "marketing",
      "permission",
    ],
    ignoreSharedDecoy: true,
    // A consent DATE or SOURCE is not the consent flag itself.
    decoy: /date|time|at$|when|source|ip|method|text|version/,
  },
  tags: { tokens: ["tags", "tag", "labels", "segment", "groups", "group"] },
  lastEventName: {
    tokens: ["lasteventname", "lasteventattended", "lastevent", "eventname", "mostrecentevent", "event"],
    decoy: /date|time|count|id$|number/,
  },
  lastEventDate: {
    tokens: ["lasteventdate", "lastattended", "lastorderdate", "lastpurchase", "lastorder", "eventdate"],
  },
  ticketsBought: {
    tokens: ["ticketsbought", "ticketspurchased", "ticketcount", "totaltickets", "orders", "tickets", "quantity"],
  },
  totalSpend: {
    tokens: ["totalspend", "lifetimevalue", "totalvalue", "totalspent", "revenue", "spend", "amount"],
  },
};

function normHeader(h: string): string {
  return h.toLowerCase().replace(/[\s_.\-()[\]/]/g, "");
}

function scoreHeader(normalised: string, spec: FieldSpec): number {
  if (!normalised) return 0;
  if (!spec.ignoreSharedDecoy && DECOY_RE.test(normalised)) return 0;
  if (spec.decoy?.test(normalised)) return 0;
  const { tokens } = spec;
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
 *
 * `fullName` is dropped when firstName/lastName both matched — a file with
 * "First Name", "Last Name" AND "Name" should use the split pair, not re-derive
 * it from a column that is probably their concatenation.
 */
export function autoMapColumns(headers: string[]): ColumnMapping {
  const mapping = emptyMapping();

  const scored: Array<{ field: ImportField; header: string; score: number }> = [];
  for (const field of IMPORT_FIELDS) {
    for (const header of headers) {
      const score = scoreHeader(normHeader(header), FIELD_SPECS[field]);
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

  if (mapping.fullName && mapping.firstName && mapping.lastName) mapping.fullName = "";
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

// ── Full-name splitting ─────────────────────────────────────────────────────

const TITLE_RE = /^(mr|mrs|ms|miss|mx|dr|prof|professor|sir|dame|lord|lady|rev)\.?$/i;
const SUFFIX_RE = /^(jr|sr|i{1,3}|iv|phd|md|obe|mbe|cbe)\.?,?$/i;
/**
 * Surname particles. "Van Der Berg" is ONE surname, so the split has to walk
 * back from the end rather than just taking the final word.
 */
const PARTICLE_RE = /^(van|von|der|den|de|di|da|du|del|della|la|le|el|al|bin|ibn|mac|mc|o'|st|saint|ter|ten)$/i;

export interface SplitName {
  firstName?: string;
  lastName?: string;
}

/**
 * Split one name cell into first + last.
 *
 * Deliberately conservative: this is a guess about someone's actual name, and a
 * wrong guess shows up in the greeting line of a marketing email. When the shape
 * is unreadable the whole value goes to firstName — a mail addressed to the full
 * name reads fine, whereas an invented surname does not.
 */
export function splitFullName(raw: string): SplitName {
  const cleaned = raw.trim().replace(/\s+/g, " ");
  if (!cleaned) return {};

  // "Smith, John" — comma form is unambiguous, and it is inverted.
  const comma = cleaned.split(",");
  if (comma.length === 2 && comma[0].trim() && comma[1].trim() && !SUFFIX_RE.test(comma[1].trim())) {
    const last = comma[0].trim();
    const first = comma[1].trim();
    return { firstName: first || undefined, lastName: last || undefined };
  }

  let parts = cleaned.replace(/,/g, " ").split(" ").filter(Boolean);
  while (parts.length > 1 && TITLE_RE.test(parts[0])) parts.shift();
  while (parts.length > 1 && SUFFIX_RE.test(parts[parts.length - 1])) parts.pop();

  if (parts.length === 0) return {};
  if (parts.length === 1) return { firstName: parts[0] };

  // Walk back over particles so "de la Cruz" stays whole.
  let cut = parts.length - 1;
  while (cut > 1 && PARTICLE_RE.test(parts[cut - 1])) cut--;

  return {
    firstName: parts.slice(0, cut).join(" ") || undefined,
    lastName: parts.slice(cut).join(" ") || undefined,
  };
}

// ── Consent column ──────────────────────────────────────────────────────────

export type ConsentValue = "yes" | "no" | "unknown";

const CONSENT_YES = new Set([
  "y", "yes", "true", "1", "t", "optin", "optedin", "subscribe", "subscribed",
  "consented", "consent", "granted", "given", "active", "on", "agree", "agreed", "allow", "allowed",
]);
const CONSENT_NO = new Set([
  "n", "no", "false", "0", "f", "optout", "optedout", "unsubscribe", "unsubscribed",
  "declined", "denied", "revoked", "withdrawn", "inactive", "off", "disagree", "none", "never",
]);

/**
 * Read a consent cell.
 *
 * Only an EXPLICIT negative blocks an import. A blank or unrecognised value is
 * "unknown", not "no": most exports omit the column entirely, and treating
 * silence as refusal would make the feature reject whole legitimate files. The
 * consent warranty on the review step remains the actual legal basis.
 */
export function parseConsent(raw: string | undefined): ConsentValue {
  if (raw == null) return "unknown";
  const v = raw.trim().toLowerCase().replace(/[\s_\-.]/g, "");
  if (!v) return "unknown";
  if (CONSENT_YES.has(v)) return "yes";
  if (CONSENT_NO.has(v)) return "no";
  return "unknown";
}

// ── Mapping views (for the column-mapping UI) ───────────────────────────────

/** header → field, for a UI that presents the organiser's columns as the objects. */
export function invertMapping(mapping: ColumnMapping): Map<string, ImportField> {
  const byHeader = new Map<string, ImportField>();
  for (const field of IMPORT_FIELDS) {
    if (mapping[field]) byHeader.set(mapping[field], field);
  }
  return byHeader;
}

/**
 * Assign a role to a column, keeping the mapping one-to-one.
 *
 * Two columns cannot share a role, so claiming one releases whatever held it.
 * Returns a new mapping — callers reassign rather than mutate, so Svelte's
 * reactivity sees the change.
 */
export function assignField(
  mapping: ColumnMapping,
  header: string,
  field: ImportField | null,
): ColumnMapping {
  const next = { ...mapping };
  for (const f of IMPORT_FIELDS) {
    if (next[f] === header) next[f] = "";
  }
  if (field) next[field] = header;
  return next;
}

/**
 * First few distinct non-empty values in a column.
 *
 * The mapping UI shows these under each header. Real values are how a person
 * actually checks a mapping — a column called "Contact" holding phone numbers is
 * obvious from the data and invisible from the header.
 */
export function sampleValues(
  rows: Array<Record<string, string>>,
  header: string,
  limit = 3,
): string[] {
  const seen = new Set<string>();
  // Bounded scan: lists run to 20k rows and this runs for every column on render.
  const scanned = Math.min(rows.length, 200);
  for (let i = 0; i < scanned && seen.size < limit; i++) {
    const value = (rows[i][header] ?? "").trim();
    if (value) seen.add(value);
  }
  return [...seen];
}

/** How full the mapping is — drives the progress readout on the mapping step. */
export function mappingSummary(headers: string[], mapping: ColumnMapping) {
  const byHeader = invertMapping(mapping);
  const assigned = headers.filter((h) => byHeader.has(h));
  return {
    assigned: assigned.length,
    total: headers.length,
    hasEmail: Boolean(mapping.email),
  };
}

// ── The import manifest ─────────────────────────────────────────────────────

export interface ImportReport {
  /** Valid, de-duplicated, not-already-in-the-list contacts, ready to add */
  candidates: MarketingContact[];
  invalidRows: number;
  dupesInFile: number;
  dupesVsList: number;
  /** Rows whose consent column said no — excluded, never importable */
  declinedConsent: number;
}

export interface BuildReportOptions {
  source: string;
  addedAt: string;
}

/**
 * Turn parsed CSV rows into the import manifest. Every row lands in exactly one
 * bucket — the tallies the organiser sees must account for the whole file.
 *
 * Bucket order is deliberate: a declined-consent row is counted as declined even
 * if it is also a duplicate, because that is the fact the organiser needs to see.
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
  let declinedConsent = 0;

  for (const row of rows) {
    const email = normaliseEmail(row[mapping.email] ?? "");
    if (!EMAIL_RE.test(email)) {
      invalidRows++;
      continue;
    }

    // Consent is checked before dedupe: an explicit "no" must never be imported,
    // and the organiser should see it counted as a refusal rather than a dupe.
    if (mapping.consent && parseConsent(row[mapping.consent]) === "no") {
      declinedConsent++;
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

    let firstName = pick("firstName");
    let lastName = pick("lastName");
    if (mapping.fullName && (!firstName || !lastName)) {
      const split = splitFullName(row[mapping.fullName] ?? "");
      firstName ??= split.firstName;
      lastName ??= split.lastName;
    }

    candidates.push({
      email,
      firstName,
      lastName,
      phone: pick("phone"),
      address1: pick("address1"),
      address2: pick("address2"),
      postcode: pick("postcode"),
      city: pick("city"),
      country: pick("country"),
      dob: pick("dob"),
      tags: pick("tags"),
      lastEventName: pick("lastEventName"),
      lastEventDate: pick("lastEventDate"),
      ticketsBought: pick("ticketsBought"),
      totalSpend: pick("totalSpend"),
      source,
      addedAt,
    });
  }

  return { candidates, invalidRows, dupesInFile, dupesVsList, declinedConsent };
}
