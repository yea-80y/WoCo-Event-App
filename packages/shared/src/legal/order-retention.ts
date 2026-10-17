/**
 * When a buyer's order-form answers fall due for deletion (#547): the event's
 * end plus the months the organiser's notice said at the time of sale.
 *
 * Calendar months in UTC, the day clamped to the last of the target month
 * (Aug 31 + 6 = Feb 28, or 29 in a leap year): "6 months after the event" read
 * the way a person reads it, and the same answer on every server whatever its
 * time zone. One helper, so a date shown to anyone and the date the sweep acts
 * on cannot disagree.
 */

import { NOTICE_RETENTION_MONTHS, type NoticeRetentionMonths } from "./organiser-notice.js";

/** Only a period an organiser can actually pick is an instruction to erase; anything else never is. */
export function isNoticeRetentionMonths(v: unknown): v is NoticeRetentionMonths {
  return (NOTICE_RETENTION_MONTHS as readonly unknown[]).includes(v);
}

/** `ms` plus `months` UTC calendar months, time of day kept, the day clamped to the month's end. */
export function addCalendarMonthsUtc(ms: number, months: number): number {
  if (!Number.isFinite(ms) || !Number.isInteger(months)) throw new RangeError("addCalendarMonthsUtc: bad input");
  const d = new Date(ms);
  const total = d.getUTCMonth() + months;
  const year = d.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const out = new Date(ms);
  // Day 1 first: setting the month on the 31st would roll over into the next one.
  out.setUTCFullYear(year, month, 1);
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return out.getTime();
}
