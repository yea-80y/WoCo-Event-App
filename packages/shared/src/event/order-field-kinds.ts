/**
 * What an order-form question asks, read from the label the organiser typed.
 *
 * The builder uses it to pre-set the `health` flag, which the organiser can undo
 * (owner 2026-10-13: defaults do the work, the organiser only acts to differ).
 * The flag marks a SENSITIVE question, whatever it asks - the wire name predates
 * the wider meaning (2026-10-15) and renaming it is churn. Every UK GDPR Art. 9
 * special category (health, dietary or access needs, religion or belief, racial
 * or ethnic origin, sexual orientation or sex life, political opinions, trade
 * union membership, genetic or biometric data) and Art. 10 criminal convictions.
 * Always optional - answering it is the buyer's explicit consent - and its answer
 * never reaches a mailing list.
 *
 * Every other answer about the buyer does, once the buyer says yes to marketing
 * (owner 2026-10-15): there is no per-question choice, so the checkout can name
 * exactly what is kept (`listKeeps`, worded in `legal/consent.ts`).
 */

import type { OrderField } from "../crypto/types.js";
import { ORDER_EMAIL_FIELD_ID } from "./order-email-id.js";

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
    // A food question is read as dietary, so "Favourite food?" costs a click (owner 2026-10-15).
    String.raw`vegan|vegetarian|pescatarian|gluten|\bnuts?\b|peanut|dairy|lactose|\bfoods?\b|\bmeals?\b|menu`,
    String.raw`(additional|support|extra)\s+needs|adjustments|guide\s+dog|assistance\s+dog|\bcarer|companion|blue\s+badge`,
    String.raw`vaccin|covid|\bhiv\b|injur|dyslex|dyspra|impair|hard\s+of\s+hearing|sighted|seizure|photosensitiv`,
    String.raw`lift\s+access|step[-\s]?free`,
    // Religion or belief. "Christian name" is a first name.
    String.raw`religio|\bfaith\b|\bbeliefs?\b|halal|kosher|\bpray|worship|\bchurch|mosque|synagogue|gurdwara`,
    String.raw`jewish|muslim|\bislam|hindu|\bsikh|buddhis|\bcatholic|protestant|\batheis|\bchristian(?!\s+names?\b)`,
    // Racial or ethnic origin.
    String.raw`\bethnic|\bracial\b|skin\s+colou?r|\bbame\b|\bbipoc\b`,
    // Sexual orientation or sex life.
    String.raw`sexual|\bsex\s+life\b|\blgbt|\bgay\b|\blesbian\b|\bqueer\b`,
    // Political opinions. Voting for a favourite act is a poll, not an opinion.
    String.raw`politic|voting\s+intention|\bwho\s+(did|do|will|would)\s+you\s+vote|\bparty\s+(member|affiliation|support)`,
    String.raw`\bvot(e[ds]?|ers?|ing)\b(?!\s+for\s+(your|the|a|an|our)\s+(favou?rite|best|top)\b)`,
    // Trade union membership.
    String.raw`trade\s+union|\bunion\s+(member|membership|rep)\b`,
    // Genetic or biometric data.
    String.raw`genetic|\bdna\b|biometric|fingerprint|facial\s+(recognition|scan)|retina|\biris\s+scan`,
    // Criminal convictions and offences (Art. 10).
    String.raw`criminal|conviction|\boffen[cs]es?\b|offender|\bcautions?\b|\bdbs\b|\bcrb\b|police\s+(record|check)|\bunspent\b`,
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

export interface OrderFieldKind {
  health: boolean;
  slot: ListSlot;
}

export function orderFieldKind(label: string): OrderFieldKind {
  const text = label.replace(/\s+/g, " ").trim();
  if (SENSITIVE_RE.test(text)) return { health: true, slot: null };
  return { health: false, slot: SLOTS.find(([, re]) => re.test(text))?.[0] ?? null };
}

/**
 * A sensitive question, as every surface must treat it. The organiser's saved
 * answer decides: `false` is theirs to give (the "Not sensitive?" override), and
 * a question saved without one is read from its label. Anything else is doubt in
 * an organiser-signed feed, and every use of this reads doubt the safe way:
 * optional, noted, never kept.
 */
export function isHealthField(field: Pick<OrderField, "health" | "label">): boolean {
  if (field.health === false) return false;
  if (field.health === undefined) return orderFieldKind(typeof field.label === "string" ? field.label : "").health;
  return true;
}

/**
 * Another person's details. The buyer's yes covers the buyer only, and a phone
 * question like this would otherwise fill the entry's own phone with someone
 * else's number. Not sensitive, so not forced optional: just never kept.
 */
const SOMEONE_ELSE_RE = /emergency|next\s+of\s+kin|guardian|\bparent|\bcarer|\bcontact\s+(name|number|phone|person)/i;

/**
 * Copied onto the buyer's list entry once they say yes to marketing: every
 * answer but a sensitive one, one about someone else, and the platform's email
 * field, which is the entry's own address.
 */
export function isKeptOnList(field: Pick<OrderField, "id" | "health" | "label">): boolean {
  if (field.id === ORDER_EMAIL_FIELD_ID || isHealthField(field)) return false;
  return !SOMEONE_ELSE_RE.test(typeof field.label === "string" ? field.label : "");
}

/** Where a kept answer lands, under the label the buyer saw. Null = not kept, or no label to name it by. */
export function listPlacement(field: OrderField): { slot: ListSlot; label: string } | null {
  if (!isKeptOnList(field)) return null;
  const label = typeof field.label === "string" ? field.label.replace(/\s+/g, " ").trim() : "";
  return label ? { slot: orderFieldKind(label).slot, label } : null;
}

const NAME_SLOTS: ReadonlySet<ListSlot> = new Set(["firstName", "lastName", "fullName"]);

/** What a yes to marketing keeps besides the email. */
export interface ListKeeps {
  /** A name question is asked. */
  name: boolean;
  /** Every other kept question's label, in form order. */
  answers: string[];
}

/**
 * Read from the event's questions. The checkout names exactly this, so the list
 * import places answers by `listPlacement` too: what is said is what is kept.
 */
export function listKeeps(fields: readonly OrderField[] | undefined): ListKeeps {
  let name = false;
  const answers: string[] = [];
  for (const field of Array.isArray(fields) ? fields : []) {
    const at = field && typeof field === "object" ? listPlacement(field) : null;
    if (!at) continue;
    if (NAME_SLOTS.has(at.slot)) name = true;
    else if (!answers.includes(at.label)) answers.push(at.label);
  }
  return { name, answers };
}

/**
 * Shown under a sensitive question at checkout. The note is itself the express
 * statement Art. 9(2)(a) asks for, so answering the optional question is the
 * buyer's explicit consent to exactly this use.
 */
export const HEALTH_FIELD_NOTE =
  "Optional - by answering, you agree we use this only for the event. Never used for marketing or added to a mailing list, and deleted with the rest of your booking.";
