/**
 * Where each content-feed family is stamped: ONE table, read by the client AND
 * the server (#657).
 *
 * WHY IT IS SHARED. A family is read and written by both ends: the server relays
 * every client write and scans some families itself (the campaign issuer's
 * countersign check, the indexer, the event money path), and it writes the
 * issuer's and indexer's own feeds. Client and server deploy separately, so a
 * table on each side is a family split between two stores for the gap between
 * the deploys - and a feed read from one store and written to another resolves
 * its PREVIOUS version as current (#651). Moving a family is one line here; the
 * server goes out first and says what it runs (`/api/health` `feedRoutes`), then
 * the frontend.
 *
 * `etherna` rows are read from our bee AND Etherna, so a move never strands what
 * a family wrote before it. `woco` rows are read from our bee alone and never
 * wait on Etherna.
 */

/** The canonical gateways. Recorded on feeds, sent by clients, and the only
 *  hosts routing recognises - a server's own fetch base is configured
 *  separately and is never a routing signal. */
export const ETHERNA_GATEWAY_URL = "https://gateway.etherna.io";
export const WOCO_GATEWAY_URL = "https://gateway.woco-net.com";

export type FeedStore = "etherna" | "woco";

export const FEED_FAMILY_STORES = {
  /** Profile data + avatar pointer (#617, #651). Client-written. */
  profile: "etherna",
  /**
   * Reading event detail feeds - a DISCOVERY row. New events are stamped on
   * Etherna and older ones on WoCo, and which one is recorded INSIDE the feed,
   * so a reader has to ask both. Writes follow each event's own recorded
   * gateway, never this row.
   */
  event: "etherna",
  /** Reading a site's client-signed config - a discovery row, like `event`. */
  site: "etherna",
  /** The encrypted-to-self backup/feed manifest (#689). Client-written. */
  manifest: "etherna",
  /** Likes, follows, Interested, and their subject index (#689). Client-written. */
  social: "etherna",
  /** The referee's own referral statement and its subject index (#689). Client-written;
   *  the server's issuer reads it before it countersigns. */
  referral: "etherna",
  /** Referral confirmations, badges and the referrer index. SERVER-written by the
   *  campaign issuer, read by clients. */
  campaignIssuer: "woco",
  /** Recovery: the portability envelope, the escrow envelope, the guardian's account index. */
  recoveryPortability: "etherna",
  recoveryEnvelope: "etherna",
  guardianIndex: "woco",
  /** Coaster laps and their indexes. Moves last: a wrong read restarts a lifetime count. */
  credits: "woco",
  /** The certificate rail, outside launch scope. */
  cert: "woco",
  /** The social indexer's published evidence reports (#312). SERVER-written platform output. */
  evidence: "woco",
} as const satisfies Record<string, FeedStore>;

export type FeedFamily = keyof typeof FEED_FAMILY_STORES;

export const FEED_FAMILIES = Object.freeze(Object.keys(FEED_FAMILY_STORES) as FeedFamily[]);

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Is `url` served by `canonical`'s host or a subdomain of it? A dot boundary on
 * the left: `eu.gateway.etherna.io` counts, `xgateway.etherna.io` and
 * `gateway.etherna.io.example.com` do not. The value is often organiser- or
 * client-written (a feed's recorded gateway, a request field), so a look-alike
 * host must never select a store.
 */
export function gatewayHostMatches(url: string | undefined, canonical: string): boolean {
  if (!url) return false;
  const host = hostOf(url);
  const want = hostOf(canonical);
  if (!host || !want) return false;
  return host === want || host.endsWith("." + want);
}

export function isEthernaGatewayUrl(url: string | undefined): boolean {
  return gatewayHostMatches(url, ETHERNA_GATEWAY_URL);
}

export function isWocoGatewayUrl(url: string | undefined): boolean {
  return gatewayHostMatches(url, WOCO_GATEWAY_URL);
}
