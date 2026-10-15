/**
 * The Attendees tab's list: sorted by ticket type and number, searched by name,
 * email or ticket number - the only things a door entry carries - and how each
 * entry is named on the list and the scan card.
 */
import type { RosterEntry } from "@woco/shared";

/**
 * A sale's name is the name on the card that paid, which need not be the guest's, so
 * it reads "Paid by Jane Smith" (owner, 2026-10-15). The organiser's list shows as is.
 */
export function attendeeName(r: Pick<RosterEntry, "name" | "email" | "edition" | "source">): string {
  if (r.name) return r.source === "sale" ? `Paid by ${r.name}` : r.name;
  return r.email || `Ticket #${r.edition}`;
}

export function searchAttendees(list: RosterEntry[], query: string): RosterEntry[] {
  const q = query.trim().toLowerCase();
  const sorted = [...list].sort((a, b) => a.seriesId.localeCompare(b.seriesId) || a.edition - b.edition);
  if (!q) return sorted;
  const ticket = q.replace(/^#/, "");
  return sorted.filter(
    (r) => r.name?.toLowerCase().includes(q) || r.email?.toLowerCase().includes(q) || String(r.edition) === ticket,
  );
}
