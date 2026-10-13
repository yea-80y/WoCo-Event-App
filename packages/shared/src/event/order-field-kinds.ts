/**
 * What an order-form question asks, read from the label the organiser typed.
 *
 * The builder uses it to pre-set two flags the organiser can change (owner
 * 2026-10-13: defaults do the work, the organiser only acts to differ):
 *   - `health`: allergies, dietary or access needs. Special category data
 *     (UK GDPR Art. 9), so the question is always optional - answering it is the
 *     buyer's explicit consent - and its answer never reaches a mailing list.
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

const HEALTH_RE =
  /allerg|intoleran|dietary|\bdiet\b|medical|medication|\bhealth\b|disabilit|\bdisabled\b|wheelchair|mobility|access(ibility)?\s+(needs?|requirements?)|accessibility|pregnan|special\s+(needs?|requirements?)|coeliac|celiac|epilep|diabet|asthma/i;

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
  if (HEALTH_RE.test(text)) return { health: true, slot: null, keepByDefault: false };
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
 * Shown under a health question at checkout. Answering an optional question
 * that says exactly this is the explicit consent Art. 9(2)(a) asks for.
 */
export const HEALTH_FIELD_NOTE =
  "Optional - used only to look after you at the event, never for marketing, and deleted with the rest of your booking.";
