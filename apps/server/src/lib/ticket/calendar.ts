/**
 * "Add to calendar" and "Get directions" for the ticket email: a Google Calendar
 * link, an .ics attachment (Apple Calendar, Outlook and the rest open it) and a
 * maps search. All built from the event's own fields; nothing is looked up.
 */

import { createHash } from "node:crypto";

/** 20261114T220000Z */
function icsStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function validDate(iso?: string): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface CalendarEvent {
  eventId: string;
  title: string;
  startIso?: string;
  endIso?: string;
  location?: string;
}

/** The end to give a calendar: the event's own, else the start (a calendar entry needs one). */
function span(ev: CalendarEvent): { start: Date; end: Date } | null {
  const start = validDate(ev.startIso);
  if (!start) return null;
  const end = validDate(ev.endIso);
  return { start, end: end && end > start ? end : start };
}

export function googleCalendarUrl(ev: CalendarEvent): string | null {
  const s = span(ev);
  if (!s) return null;
  const q = new URLSearchParams({ action: "TEMPLATE", text: ev.title, dates: `${icsStamp(s.start)}/${icsStamp(s.end)}` });
  if (ev.location) q.set("location", ev.location);
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

export function directionsUrl(location?: string): string | null {
  const loc = location?.trim();
  if (!loc) return null;
  // URLSearchParams never throws (encodeURIComponent does, on a lone surrogate).
  return `https://www.google.com/maps/search/?${new URLSearchParams({ api: "1", query: loc }).toString()}`;
}

/** RFC 5545 text escaping. */
function icsText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

/** Fold a content line at 75 octets, continuation lines starting with a space. */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curLen = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    const limit = out.length === 0 ? 75 : 74;
    if (curLen + n > limit) {
      out.push(cur);
      cur = "";
      curLen = 0;
    }
    cur += ch;
    curLen += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

/** A stable UID part: the event id, else a hash of title and start, so two
 *  events never share one and dedupe into a single calendar entry. */
function uidPart(ev: CalendarEvent, start: Date): string {
  const id = ev.eventId.replace(/[^A-Za-z0-9._-]/g, "");
  return id || createHash("sha256").update(`${ev.title}|${start.toISOString()}`).digest("hex").slice(0, 32);
}

/** The .ics file for one event, or null without a valid start. */
export function eventIcs(ev: CalendarEvent, now: Date = new Date()): string | null {
  const s = span(ev);
  if (!s) return null;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//WoCo//Tickets//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uidPart(ev, s.start)}@woco-net.com`,
    `DTSTAMP:${icsStamp(now)}`,
    `DTSTART:${icsStamp(s.start)}`,
    `DTEND:${icsStamp(s.end)}`,
    `SUMMARY:${icsText(ev.title)}`,
    ...(ev.location ? [`LOCATION:${icsText(ev.location)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
