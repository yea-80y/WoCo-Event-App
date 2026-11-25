/**
 * The launch rate (Organiser Terms §6): our fee on a card ticket sale is
 * LAUNCH_RATE_FEE_BP while the organiser's payment account is within
 * LAUNCH_RATE_MONTHS of its first paid sale, PLATFORM_FEE_BP after. Pure: the
 * first-sale date comes from first-sales.ts, the instant from the caller.
 *
 * Decided when the checkout session is created, the only point it can be: the
 * fee goes into the session's integrity tag and its PaymentIntent then. A
 * session still open when the launch rate ends keeps the rate it was made at.
 *
 * Errs towards the organiser on purpose (owner, 2026-11-25): no first sale on
 * record, for any reason, is the launch rate.
 */

import { LAUNCH_RATE_FEE_BP, LAUNCH_RATE_MONTHS, PLATFORM_FEE_BP, type PlatformFeeBp } from "@woco/shared";

const HOUR_MS = 60 * 60 * 1000;

export interface LaunchRateEnd {
  /** The last day of the launch rate, YYYY-MM-DD: what an organiser is shown. */
  lastDay: string;
  /** The first instant the standard rate applies, epoch ms. */
  endMs: number;
}

/**
 * The corresponding date LAUNCH_RATE_MONTHS after the first sale's date, clamped
 * to the end of a shorter month (30 Nov -> 28 Feb), is the last day. Both ends
 * are read the way most generous to the organiser, wherever they are (§6 says
 * "wherever you are in the world"): the first sale's date is the latest calendar
 * date anywhere on earth at that moment (UTC+14), so nobody's own date is later;
 * and the rate runs through the end of the last day everywhere, which is 12:00
 * UTC the day after. The cost is at most one extra day at the launch rate.
 */
export function launchRateEnd(firstSaleMs: number): LaunchRateEnd {
  const first = new Date(firstSaleMs + 14 * HOUR_MS);
  const months = first.getUTCMonth() + LAUNCH_RATE_MONTHS;
  const year = first.getUTCFullYear() + Math.floor(months / 12);
  const month = months % 12;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const lastDayMs = Date.UTC(year, month, Math.min(first.getUTCDate(), daysInMonth));
  return {
    lastDay: new Date(lastDayMs).toISOString().slice(0, 10),
    endMs: lastDayMs + 36 * HOUR_MS,
  };
}

/** Our fee rate for a checkout created at `atMs` on an account whose first paid sale was at `firstSaleMs`. */
export function platformFeeBpAt(firstSaleMs: number | null, atMs: number): PlatformFeeBp {
  if (firstSaleMs === null) return LAUNCH_RATE_FEE_BP;
  return atMs < launchRateEnd(firstSaleMs).endMs ? LAUNCH_RATE_FEE_BP : PLATFORM_FEE_BP;
}
