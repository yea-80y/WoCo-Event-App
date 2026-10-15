/** Format a Date as a `datetime-local` input value in the user's LOCAL time
 *  (YYYY-MM-DDTHH:mm). `toISOString()` would shift to UTC and mis-set the
 *  picker, so we build the string from the local field getters. */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** `datetime-local` value for `now + offsetMinutes`, local time. */
export function localInputFromNow(offsetMinutes: number): string {
  return toLocalInput(new Date(Date.now() + offsetMinutes * 60_000));
}

/** A `datetime-local` (or date-only) value read as the organiser's LOCAL wall-clock
 *  time, as an absolute UTC instant. `new Date("YYYY-MM-DD")` reads a date-only value
 *  as UTC midnight, so the fields are taken apart here. Null when it isn't a real date. */
export function localInputToIso(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((v) => Number(v ?? 0)) as [number, number, number, number, number, number];
  if (h > 23 || mi > 59 || s > 59) return null;
  const date = new Date(y, mo - 1, d, h, mi, s);
  // An impossible day (Feb 30) rolls into the next month rather than failing.
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date.toISOString();
}

/** An imported sale bound for the picker: a date-only value covers that whole day. */
export function importedSaleBound(value: string | undefined, edge: "start" | "end"): string {
  if (!value) return "";
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T${edge === "start" ? "00:00" : "23:59"}` : value;
}

/**
 * What is wrong with a ticket type's sale window, in the organiser's words, or null.
 * All three values are picker values. The event's end stops every sale on its own
 * (the contract refuses mints after it), so a later close would never take effect.
 */
export function saleWindowError(
  window: { saleStart?: string; saleEnd?: string },
  eventEnd: string,
): string | null {
  const opens = window.saleStart ? localInputToIso(window.saleStart) : undefined;
  const closes = window.saleEnd ? localInputToIso(window.saleEnd) : undefined;
  if (opens === null) return "Enter a valid time for sales to open.";
  if (closes === null) return "Enter a valid time for sales to close.";
  const end = eventEnd ? localInputToIso(eventEnd) : null;
  if (opens && closes && Date.parse(closes) <= Date.parse(opens)) return "Sales must close after they open.";
  if (end && closes && Date.parse(closes) > Date.parse(end)) {
    return "Sales can't close after the event ends - ticket sales stop when the event ends anyway.";
  }
  if (end && opens && Date.parse(opens) >= Date.parse(end)) return "Sales must open before the event ends.";
  return null;
}
