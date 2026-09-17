/**
 * The passport's ticket rules, pure so the suite can pin them.
 *
 * A member's tickets are the account's LINKED tickets — the unlock status
 * already returns them — joined to event details for titles and dates. The old
 * collection feed is not read: nothing has written it since the v1 claim rail
 * was deleted (#268).
 */

import type { SnapshotCard } from "@woco/shared";
import type { GateBindingSummary } from "../../api/attendee-gate.js";
import { isPastEvent } from "../../utils/events.js";

export type PassportEvent = Pick<
  SnapshotCard,
  "title" | "startDate" | "endDate" | "location" | "creatorFeedSigner" | "apiUrl"
>;

type PassportEventSource = PassportEvent & { eventId: string };

export interface PassportTicket {
  eventId: string;
  seriesId: string;
  edition: number;
  /** Null when the event's details are not known yet. */
  event: PassportEvent | null;
}

export interface PassportTickets {
  upcoming: PassportTicket[];
  past: PassportTicket[];
  /** Tickets whose event details are missing or unreadable — kept, never dropped. */
  unknown: PassportTicket[];
}

/**
 * Details for the events the member holds tickets for: the public directory
 * first, then an event's own record for one the directory does not list. A
 * record counts only under the id it names.
 */
export function eventsIndex(
  eventIds: readonly string[],
  directory: readonly PassportEventSource[],
  records: readonly (PassportEventSource | null | undefined)[],
): Record<string, PassportEvent> {
  const wanted = new Set(eventIds);
  const filled = new Set<string>();
  const out: Record<string, PassportEvent> = {};
  for (const source of [...directory, ...records]) {
    if (!source || !wanted.has(source.eventId) || filled.has(source.eventId)) continue;
    filled.add(source.eventId);
    out[source.eventId] = {
      title: source.title,
      startDate: source.startDate,
      endDate: source.endDate,
      location: source.location,
      creatorFeedSigner: source.creatorFeedSigner,
      apiUrl: source.apiUrl,
    };
  }
  return out;
}

export function passportTickets(
  bindings: readonly GateBindingSummary[],
  eventsById: Readonly<Record<string, PassportEvent | undefined>>,
  now: number,
): PassportTickets {
  const out: PassportTickets = { upcoming: [], past: [], unknown: [] };
  const seen = new Set<string>();
  for (const binding of bindings) {
    // One ticket per series edition, however many times it was linked.
    const key = `${binding.seriesId}#${binding.edition}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const event = eventsById[binding.eventId] ?? null;
    const ticket: PassportTicket = {
      eventId: binding.eventId,
      seriesId: binding.seriesId,
      edition: binding.edition,
      event,
    };
    if (!event || isNaN(new Date(event.startDate).getTime())) out.unknown.push(ticket);
    else if (isPastEvent(event, now)) out.past.push(ticket);
    else out.upcoming.push(ticket);
  }

  const startOf = (t: PassportTicket) => new Date(t.event!.startDate).getTime();
  out.upcoming.sort((a, b) => startOf(a) - startOf(b));
  out.past.sort((a, b) => startOf(b) - startOf(a));
  return out;
}

/** Whole calendar days from `now` to the event's start, in the viewer's own time zone. */
export function daysUntil(startDate: string, now: number): number | null {
  const start = new Date(startDate);
  if (isNaN(start.getTime())) return null;
  const today = new Date(now);
  const startDay = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const todayDay = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((startDay - todayDay) / 86_400_000);
}

/** "Today", "Tomorrow", "In 5 days" — or nothing for a start that has passed. */
export function whenLabel(days: number | null): string | null {
  if (days === null || days < 0) return null;
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `In ${days} days`;
}
