// ---------------------------------------------------------------------------
// Swarm feed topic derivation for sites
// ---------------------------------------------------------------------------
//
// Centralised so server (writer) and deployed-site runtime (reader) agree on
// the exact strings. Mirrors the convention in `apps/server/src/lib/swarm/topics.ts`
// for events.

/** Feed topic holding the `Site` JSON for a given site. */
export function siteConfigTopic(siteId: string): string {
  return `woco/site/config/${siteId}`;
}

/** Feed topic holding the `SiteEventsIndex` for a given site. */
export function siteEventsIndexTopic(siteId: string): string {
  return `woco/site/${siteId}/events`;
}
