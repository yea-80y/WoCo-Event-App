/**
 * The signed-in member's tickets, shared by Home's "Next up" and the Profile
 * passport. Call during component setup.
 *
 * Prompt-free: the linked tickets come from the cached unlock status, and event
 * details from what this device already holds, then from public reads. Nothing
 * here asks for a session — the caller decides whether to refresh the status.
 */

import type { EventFeed, SnapshotCard } from "@woco/shared";
import { getEvent, listEvents } from "../../api/events.js";
import { cacheGet, cacheKey, cacheSet, TTL } from "../../cache/cache.js";
import { settleInBatches } from "../../utils/settle-in-batches.js";
import { gate } from "../gate/gate.svelte.js";
import { eventsIndex, passportTickets, type PassportEvent, type PassportTickets } from "./passport.js";

function cachedEvents(ids: readonly string[]): Record<string, PassportEvent> {
  const directory = cacheGet<SnapshotCard[]>(cacheKey.directory()) ?? [];
  return eventsIndex(ids, directory, ids.map((id) => cacheGet<EventFeed>(cacheKey.event(id))));
}

async function freshEvents(ids: readonly string[]): Promise<Record<string, PassportEvent>> {
  let directory = await listEvents().catch((): SnapshotCard[] => []);
  // A failed directory read also arrives as an empty list, so an empty answer
  // never replaces the copy Discover paints from.
  if (directory.length > 0) cacheSet(cacheKey.directory(), directory, TTL.EVENT);
  else directory = cacheGet<SnapshotCard[]>(cacheKey.directory()) ?? [];

  const listed = new Set(directory.map((card) => card.eventId));
  const unlisted = ids.filter((id) => !listed.has(id));
  const reads = await settleInBatches(unlisted, 4, (id) => getEvent(id));
  const records = reads.map((read) => (read.status === "fulfilled" ? read.value : null));
  return eventsIndex(ids, directory, records);
}

export function passportState(): {
  readonly tickets: PassportTickets;
  /** Event details are still being fetched. */
  readonly loading: boolean;
  readonly now: number;
} {
  let events = $state<Record<string, PassportEvent>>({});
  let loading = $state(false);
  let now = $state(Date.now());

  const bindings = $derived(gate.status?.bindings ?? []);
  // Keyed on the SET of events, so a status refresh that returns the same
  // tickets does not fetch again.
  const idsKey = $derived(JSON.stringify([...new Set(bindings.map((b) => b.eventId))].sort()));
  const tickets = $derived(passportTickets(bindings, events, now));

  $effect(() => {
    const ids: string[] = JSON.parse(idsKey);
    events = cachedEvents(ids);
    loading = ids.length > 0;
    if (!loading) return;
    let current = true;
    freshEvents(ids)
      .then((fresh) => { if (current) events = { ...events, ...fresh }; })
      .catch(() => { /* the cached details stay */ })
      .finally(() => { if (current) loading = false; });
    return () => { current = false; };
  });

  // Moves a ticket from upcoming to past, and "Tomorrow" to "Today", while open.
  $effect(() => {
    const timer = setInterval(() => { now = Date.now(); }, 60_000);
    return () => clearInterval(timer);
  });

  return {
    get tickets() { return tickets; },
    get loading() { return loading; },
    get now() { return now; },
  };
}
