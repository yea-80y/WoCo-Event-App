/**
 * What an order-form question asks, read from the label the organiser typed.
 *
 * The builder uses it to pre-set two flags the organiser can change (owner
 * 2026-10-13: defaults do the work, the organiser only acts to differ):
 *   - `health`: a SENSITIVE question, whatever it asks - the wire name predates
 *     the wider meaning (2026-10-15) and renaming it is churn. Every UK GDPR
 *     Art. 9 special category (health, dietary or access needs, religion or
 *     belief, racial or ethnic origin, sexual orientation or sex life, political
 *     opinions, trade union membership, genetic or biometric data) and Art. 10
 *     criminal convictions. Always optional - answering it is the buyer's
 *     explicit consent - and its answer never reaches a mailing list.
 *   - `keepOnList`: names and where someone lives are what a mailing list is
 *     for, so they are copied onto the buyer's list entry when the organiser
 *     imports opted-in buyers. Everything else stays with the booking and goes
 *     when the booking's answers are deleted.
 *
 * A guess, never a gate: the flags the organiser saved are what every surface
 * reads. Only `isHealthField` is enforced, and only in the safe direction.
 */

import type { OrderField } from "../crypto/types.js";

/** Where a kept answer lands on a mailing-list entry. `null` = kept under its own label. */
export type ListSlot = "firstName" | "lastName" | "fullName" | "postcode" | "city" | "phone" | null;

/**
 * Every UK GDPR Art. 9 special category, plus Art. 10 criminal convictions. A
 * false positive costs the organiser one "Not sensitive?" click; a miss puts the
 * answer on a mailing list, so the categories err wide where a word is
 * unambiguous and stay narrow where it is not (a bare "race" is a running race
 * at most WoCo events, a bare "union" a rugby code).
 */
const SENSITIVE_RE = new RegExp(
  [
    // Health, dietary or access needs.
    String.raw`allerg|intoleran|dietary|\bdiet\b|medical|medication|\bhealth\b|disabilit|\bdisabled\b|wheelchair|mobility`,
    String.raw`access(ibility)?\s+(needs?|requirements?)|accessibility|pregnan|special\s+(needs?|requirements?)`,
    String.raw`coeliac|celiac|epilep|diabet|asthma|\bmental\b|neurodiverg|autis|\badhd\b|\bdeaf|hearing\s+(loop|impair|aid)`,
    String.raw`\bblind\b|visual(ly)?\s+impair|\bbsl\b|sign\s+language`,
    // Religion or belief.
    String.raw`religio|\bfaith\b|\bbeliefs?\b|halal|kosher|\bpray|worship|\bchurch|mosque|synagogue|gurdwara`,
    String.raw`\bjewish\b|\bmuslim\b|\bhindu\b|\bsikh\b|\bbuddhis|\bcatholic\b|\batheis`,
    // Racial or ethnic origin.
    String.raw`\bethnic|\bracial\b|skin\s+colou?r|\bbame\b|\bbipoc\b`,
    // Sexual orientation or sex life.
    String.raw`sexual|\bsex\s+life\b|\blgbt|\bgay\b|\blesbian\b|\bqueer\b`,
    // Political opinions.
    String.raw`politic|voting\s+intention|\bwho\s+(did|do|will|would)\s+you\s+vote|\bparty\s+(member|affiliation|support)`,
    // Trade union membership.
    String.raw`trade\s+union|\bunion\s+(member|membership|rep)\b`,
    // Genetic or biometric data.
    String.raw`genetic|\bdna\b|biometric|fingerprint|facial\s+(recognition|scan)|retina|\biris\s+scan`,
    // Criminal convictions and offences (Art. 10).
    String.raw`criminal|conviction|\boffen[cs]es?\b|\bdbs\b|\bcrb\b|police\s+(record|check)|\bunspent\b`,
  ].join("|"),
  "i",
);

const SLOTS: [Exclude<ListSlot, null>, RegExp][] = [
  ["firstName", /\b(first|given)\s*name\b|\bforename\b/i],
  ["lastName", /\b(last|family)\s*name\b|\bsurname\b/i],
  ["fullName", /^\s*(your\s+)?(full\s+)?name\s*\??\s*$|^\s*(attendee|guest|ticket\s*holder)'?s?\s+name\s*$/i],
  ["postcode", /\bpost\s*code\b|\bpostal\s*code\b|\bzip\b/i],
  ["city", /^\s*(your\s+|local\s+|home\s+)?(town|city|area|location|town\s*\/\s*city|town\s+or\s+city)\s*\??\s*$|where\s+(do\s+you\s+live|are\s+you\s+(from|based))/i],
  ["phone", /\bphone\b|\bmobile\b|\btelephone\b/i],
];

/** Slots kept on the list unless the organiser unticks them. Phone is not: texting needs its own basis. */
const KEPT_BY_DEFAULT: ReadonlySet<ListSlot> = new Set(["firstName", "lastName", "fullName", "postcode", "city"]);

export interface OrderFieldKind {
  health: boolean;
  slot: ListSlot;
  keepByDefault: boolean;
}

export function orderFieldKind(label: string): OrderFieldKind {
  const text = label.replace(/\s+/g, " ").trim();
  if (SENSITIVE_RE.test(text)) return { health: true, slot: null, keepByDefault: false };
  const slot = SLOTS.find(([, re]) => re.test(text))?.[0] ?? null;
  return { health: false, slot, keepByDefault: KEPT_BY_DEFAULT.has(slot) };
}

/**
 * A health question, as every surface must treat it. The organiser's flag is
 * the source, but an event feed is organiser-signed and only bounded at create,
 * so `true` is the only value that counts.
 */
export function isHealthField(field: Pick<OrderField, "health">): boolean {
  return field.health === true;
}

/** Copied onto a mailing list: ticked, and never a health question whatever the flags say. */
export function isKeptOnList(field: Pick<OrderField, "health" | "keepOnList">): boolean {
  return field.keepOnList === true && !isHealthField(field);
}

/**
 * Shown under a health question at checkout. The note is itself the express
 * statement Art. 9(2)(a) asks for, so answering the optional question is the
 * buyer's explicit consent to exactly this use.
 */
export const HEALTH_FIELD_NOTE =
  "Optional - by answering, you agree we use this only to look after you at the event. Never used for marketing, and deleted with the rest of your booking.";
