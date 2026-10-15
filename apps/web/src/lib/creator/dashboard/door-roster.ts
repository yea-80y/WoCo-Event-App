/**
 * The door's list, built from the organiser's decrypted orders: each ticket, its
 * ticket type, a name and an email - nothing else (owner, 2026-10-15). The other
 * order-form answers (dietary needs, custom questions) stay on the dashboard; the
 * door does not need them to let someone in.
 */
import type { RosterEntry } from "@woco/shared";

export interface DoorRosterOrder {
  seriesId: string;
  seriesName?: string;
  edition: number;
}

export interface DoorRosterDecrypted {
  fields?: Record<string, string>;
  claimerEmail?: string;
}

/** `decrypted` is keyed by the order's index in `orders`. The name is the first answer whose question mentions "name". */
export function buildRosterEntries(
  orders: DoorRosterOrder[],
  decrypted: Map<number, DoorRosterDecrypted>,
  seriesNames: Map<string, string>,
): RosterEntry[] {
  return orders.map((order, idx) => {
    const dec = decrypted.get(idx);
    const fields = dec?.fields;
    const nameKey = fields ? Object.keys(fields).find((k) => /name/i.test(k)) : undefined;
    const name = nameKey ? fields![nameKey] : undefined;
    const email = dec?.claimerEmail;
    return {
      seriesId: order.seriesId,
      seriesName: seriesNames.get(order.seriesId) ?? order.seriesName ?? "",
      edition: order.edition,
      ...(typeof name === "string" && name ? { name } : {}),
      ...(typeof email === "string" && email ? { email } : {}),
    };
  });
}
