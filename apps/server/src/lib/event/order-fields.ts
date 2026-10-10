/**
 * Bounds on an event's order form, checked at create (#720).
 *
 * The form is stored as sent and every buyer's answers are sealed against it,
 * so nothing else bounds the plaintext an order box can carry. The 16 KB cap on
 * the sealed box (#642, `MAX_ORDER_BOX_JSON`) is the backstop; these keep a
 * legitimate form well inside it, and keep a malformed one (an unknown type, a
 * non-numeric maxLength the embed would interpolate) from reaching any surface.
 */

import type { OrderFieldType } from "@woco/shared";

export const MAX_ORDER_FIELDS = 20;
export const MAX_ORDER_FIELD_TEXT = 200;
export const MAX_ORDER_FIELD_OPTIONS = 50;
/** Per field. The total across fields is still bounded only by the 16 KB box cap. */
export const MAX_ORDER_FIELD_MAXLENGTH = 2000;

const TYPES: ReadonlySet<OrderFieldType> = new Set(["text", "email", "tel", "textarea", "select", "checkbox"]);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

/** Why this order form is refused, as a sentence for the organiser, or null. Absent is fine. */
export function orderFieldsRefusal(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return "orderFields must be an array";
  if (raw.length > MAX_ORDER_FIELDS) return `An order form can have at most ${MAX_ORDER_FIELDS} fields`;
  const ids = new Set<string>();
  for (const [i, f] of raw.entries()) {
    const n = `Order form field ${i + 1}`;
    if (typeof f !== "object" || f === null || Array.isArray(f)) return `${n} is not a field`;
    const { id, type, label, required, placeholder, options, maxLength } = f as Record<string, unknown>;
    if (typeof id !== "string" || !ID_RE.test(id)) return `${n} has an invalid id`;
    if (ids.has(id)) return `${n} repeats the id "${id}"`;
    ids.add(id);
    if (!TYPES.has(type as OrderFieldType)) return `${n} has an unknown type`;
    if (!isText(label, MAX_ORDER_FIELD_TEXT)) return `${n}'s label must be text of at most ${MAX_ORDER_FIELD_TEXT} characters`;
    if (typeof required !== "boolean") return `${n} must say whether it is required`;
    if (placeholder !== undefined && !isText(placeholder, MAX_ORDER_FIELD_TEXT)) {
      return `${n}'s placeholder must be text of at most ${MAX_ORDER_FIELD_TEXT} characters`;
    }
    if (options !== undefined
        && (!Array.isArray(options) || options.length > MAX_ORDER_FIELD_OPTIONS
          || options.some((o) => !isText(o, MAX_ORDER_FIELD_TEXT)))) {
      return `${n} can have at most ${MAX_ORDER_FIELD_OPTIONS} options of at most ${MAX_ORDER_FIELD_TEXT} characters`;
    }
    if (maxLength !== undefined
        && (!Number.isInteger(maxLength) || (maxLength as number) < 1 || (maxLength as number) > MAX_ORDER_FIELD_MAXLENGTH)) {
      return `${n}'s maxLength must be a whole number from 1 to ${MAX_ORDER_FIELD_MAXLENGTH}`;
    }
  }
  return null;
}
