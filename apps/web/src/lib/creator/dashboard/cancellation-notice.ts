/**
 * The cancellation notice's starting text (#644). The organiser edits it and
 * sends it from the broadcast tab — it is never sent automatically. The server
 * composes the subject ("Cancelled: {title}") and wraps this note.
 */

import type { EventFeed } from "@woco/shared";

export function cancellationNoticeTemplate(ev: Pick<EventFeed, "title" | "startDate">, locale?: string): string {
  const date = ev.startDate ? new Date(ev.startDate) : null;
  const when = date && !Number.isNaN(date.getTime())
    ? ` on ${date.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}`
    : "";
  return [
    `We're very sorry - ${ev.title}${when} has been cancelled.`,
    "",
    "Everyone who bought a ticket is being refunded in full, including any booking fee, to the card they paid with. Refunds usually arrive within 5-10 working days. You don't need to do anything.",
    "",
    "[Add a few words here - why the event was cancelled, and anything else your attendees should know.]",
    "",
    "Your ticket will no longer be accepted at the door.",
  ].join("\n");
}
