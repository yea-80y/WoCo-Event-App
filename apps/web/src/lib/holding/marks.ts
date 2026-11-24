/**
 * Which of the account's tickets have their private receipt saved in the account
 * (spec-receipt-note 5.1, Profile > Tickets): read from the account's receipt lists, every
 * generation this device holds. A line on a list is written only after its copy read
 * back, so the lists alone say "saved" - no copy is opened here.
 *
 * Never a prompt: a passkey account whose keys are locked on this device shows no marks
 * until its next unlock. A screen that only shows them reads `forList` - the last good
 * list rather than nothing - and a read that could not reach every list keeps the marks
 * an earlier read in this tab showed (Fable 3a delta).
 *
 * A mark is `markKey(eventId, seriesId, edition)`; the list's event and series ids are
 * the account's own hints, for display only.
 */
import { auth } from "../auth/auth-store.svelte.js";

export function markKey(eventId: string, seriesId: string, edition: number): string {
  return `${eventId}|${seriesId}#${edition}`;
}

const lastGood = new Map<string, Set<string>>();

/** The marks for the signed-in `parent`, or null when this device cannot read them now. */
export async function readReceiptMarks(parent: string): Promise<Set<string> | null> {
  const account = parent.toLowerCase();
  const held = await auth.getAccountSecrets().catch(() => null);
  if (!held || auth.parent?.toLowerCase() !== account) return lastGood.get(account) ?? null;
  const [{ holdingGenKeysOf, listHeldOrders }, { liveHoldingFeedIO }] = await Promise.all([
    import("./account-copy.js"),
    import("./holding-io.js"),
  ]);
  const gens = await Promise.all(held.all.map((s) => holdingGenKeysOf(s)));
  try {
    const { orders, complete } = await listHeldOrders(gens, liveHoldingFeedIO);
    const marks = new Set(orders.flatMap((o) => o.editions.map((n) => markKey(o.wocoEventId, o.seriesId, n))));
    if (!complete) for (const m of lastGood.get(account) ?? []) marks.add(m);
    if (auth.parent?.toLowerCase() !== account) return null;
    lastGood.set(account, marks);
    return marks;
  } finally {
    for (const g of gens) g.orderSecretKey.fill(0);
  }
}
