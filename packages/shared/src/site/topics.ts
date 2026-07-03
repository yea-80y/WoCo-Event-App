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

/**
 * Topic STRING of the per-site bee SEQUENCE feed that tracks the latest deployed
 * BZZ collection hash (what custom domains / a feed-manifest URL resolve). Unlike
 * our SOC content feeds this is a REAL bee feed (gateways resolve it via
 * /bzz/{feedManifestHash}), so updates use the bee identifier scheme
 * (`beeFeedUpdateIdentifier`), not `contentFeedSocIdentifier`. Client-owned sites
 * sign these updates with their own feed signer; legacy sites are platform-signed.
 */
export function multisiteFeedTopic(siteId: string): string {
  return `woco-multisite-${siteId}`;
}
