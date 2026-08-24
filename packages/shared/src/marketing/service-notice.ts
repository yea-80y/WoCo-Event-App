/**
 * Service notices — the only messages permitted to reach a ticket-holder who
 * has unsubscribed from an organiser's marketing (#60 item 1).
 *
 * WHY THEY EXIST. WoCo already delivers transactional mail to suppressed
 * addresses: ticket confirmations never consult the suppression list and carry
 * no unsubscribe link (`docs/MARKETING_COMPLIANCE.md`). The `/u` page states
 * this to the person's face — "Stop marketing emails from this organiser…
 * Ticket confirmations for events you book are not affected." So the gap was
 * arbitrary rather than principled: we would tell an unsubscribed buyer that
 * their ticket exists, but not that the event had been cancelled.
 *
 * WHY THE ORGANISER DOES NOT GET TO DECIDE. A free-text "this one is
 * operational" flag would be worth nothing — it would make crossing a
 * suppression a checkbox. So the platform owns everything that frames the
 * message: the category is one of three fixed values, the subject line is
 * composed here from that category, and a platform sentence is injected above
 * whatever the organiser wrote. The organiser supplies only the note.
 *
 * WHY THESE THREE AND NOTHING ELSE. The dividing line is a change that costs
 * the attendee money or sends them to the wrong place at the wrong time.
 * A lineup change or a doors-time tweak does not qualify: it goes out as an
 * ordinary event broadcast, and the unsubscribed minority missing it is an
 * acceptable outcome in a way that missing "it is cancelled" is not.
 *
 * There is deliberately NO "other" / "important update" member. A catch-all is
 * a free-pick flag wearing a taxonomy's clothes, and it would put the decision
 * back with the sender.
 */

export const SERVICE_NOTICE_TYPES = ["cancelled", "rescheduled", "venue_changed"] as const;

export type ServiceNoticeType = (typeof SERVICE_NOTICE_TYPES)[number];

export function isServiceNoticeType(v: unknown): v is ServiceNoticeType {
  return typeof v === "string" && (SERVICE_NOTICE_TYPES as readonly string[]).includes(v);
}

/** What the organiser picks from, in their words. */
export const SERVICE_NOTICE_LABELS: Record<ServiceNoticeType, string> = {
  cancelled: "This event is cancelled",
  rescheduled: "This event has moved to a different date or time",
  venue_changed: "This event has moved to a different venue",
};

/**
 * The subject line. Composed by the platform, never by the organiser — the
 * subject is the part a recipient reads before deciding whether they were
 * spammed, so it is the part that must not be marketing.
 */
export function serviceNoticeSubject(type: ServiceNoticeType, eventTitle: string): string {
  const prefix: Record<ServiceNoticeType, string> = {
    cancelled: "Cancelled",
    rescheduled: "New date",
    venue_changed: "New venue",
  };
  return `${prefix[type]}: ${eventTitle}`;
}

/**
 * The sentence injected above the organiser's note.
 *
 * It does three jobs at once: it tells the recipient why they are hearing from
 * someone they unsubscribed from, it is the self-labelling that makes the
 * crossing defensible to a mailbox provider or a regulator, and it makes abuse
 * legible — an organiser smuggling promotion through this channel is doing so
 * directly underneath a sentence saying the message is not promotional.
 */
export function serviceNoticeDisclosure(eventTitle: string): string {
  return (
    `You're receiving this because you hold a ticket for ${eventTitle}. ` +
    `This is a service notice about your booking, not marketing.`
  );
}
