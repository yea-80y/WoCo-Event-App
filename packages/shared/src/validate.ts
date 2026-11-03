/**
 * Closed-schema validation helpers: refuse, never normalise. For new formats.
 * (edition/, cert/, credit/ and issuer/ keep their own private copies of
 * `hasExactKeys`, inside signed formats; not moved here.)
 */

/** A plain JSON record: not null, not an array, and the built-in prototype (or none). */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Every `required` key present, nothing outside `required` + `optional`, and an optional key never `undefined`. */
export function hasExactKeys(o: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(o);
  return (
    required.every((k) => k in o) &&
    keys.every((k) => required.includes(k) || (optional.includes(k) && o[k] !== undefined))
  );
}

/** A safe integer in [min, max]. */
export function isIntIn(v: unknown, min: number, max: number): v is number {
  return Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
}

/**
 * Display text: non-empty, no leading or trailing space, no control or invisible
 * formatting characters (Cf: zero-width, direction marks), at most `max` UTF-16 units.
 * Two strings that print alike must not pass as different (seat labels are keyed on them).
 */
export function isDisplayText(v: unknown, max: number): v is string {
  return (
    typeof v === "string" && v.length > 0 && v.length <= max && v === v.trim() &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(v) && !/\p{Cf}/u.test(v)
  );
}

/** How a label is compared for "prints the same": NFC, case-folded, runs of space collapsed. */
export const labelIdentity = (s: string): string => s.normalize("NFC").toLowerCase().replace(/\s+/g, " ");
