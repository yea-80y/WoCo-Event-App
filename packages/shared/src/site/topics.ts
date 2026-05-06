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

/** Feed topic holding the Site pages array (split from config to stay under 4096 bytes). */
export function sitePagesTopicFn(siteId: string): string {
  return `woco/site/pages/${siteId}`;
}

/** Feed topic holding the `SiteEventsIndex` for a given site. */
export function siteEventsIndexTopic(siteId: string): string {
  return `woco/site/${siteId}/events`;
}

/** Feed topic for a creator's site directory (all sites they've published). */
export function siteCreatorDirectoryTopic(ethAddress: string, page = 0): string {
  const base = `woco/site/creator/${ethAddress.toLowerCase()}`;
  return page === 0 ? base : `${base}/p${page}`;
}
