/**
 * The Attendees tab's list: sorted by ticket type and number, searched by name,
 * email or ticket number - the only things a door entry carries.
 */
import type { RosterEntry } from "@woco/shared";

export function searchAttendees(list: RosterEntry[], query: string): RosterEntry[] {
  const q = query.trim().toLowerCase();
  const sorted = [...list].sort((a, b) => a.seriesId.localeCompare(b.seriesId) || a.edition - b.edition);
  if (!q) return sorted;
  const ticket = q.replace(/^#/, "");
  return sorted.filter(
    (r) => r.name?.toLowerCase().includes(q) || r.email?.toLowerCase().includes(q) || String(r.edition) === ticket,
  );
}
