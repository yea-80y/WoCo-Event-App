/**
 * Canonical gateway URLs. Beyond being read endpoints, these are the ROUTING
 * SIGNAL for server-side batch selection: /api/swarm/soc, /api/swarm/bytes and
 * the site/event deploy endpoints match the gatewayUrl host to decide which
 * postage batch pays (the caller's Etherna batch when they own a live one, the
 * shared Etherna platform batch otherwise, the WoCo platform batch when the
 * WoCo gateway — or nothing — is sent).
 */
export const ETHERNA_GATEWAY_URL = "https://gateway.etherna.io";
export const WOCO_GATEWAY_URL = "https://gateway.woco-net.com";

/**
 * Where a content feed is stamped, and so which node must be asked about it.
 *
 * REQUIRED on every content-feed read and write, with no default: a feed read
 * from one store and written to another resolves its PREVIOUS version as current,
 * and a rewrite built on that erases the newer one (#651). An omitted optional
 * argument is how that happened, so omission no longer compiles. A property of
 * the feed family - share one constant across a rail's reads and writes. Whether
 * a read may trust "not found" is a property of the call instead (`thorough`).
 */
export interface FeedRoute {
  readonly gatewayUrl: string;
}
export const ETHERNA_ROUTE: FeedRoute = Object.freeze({ gatewayUrl: ETHERNA_GATEWAY_URL });
export const WOCO_ROUTE: FeedRoute = Object.freeze({ gatewayUrl: WOCO_GATEWAY_URL });

/**
 * Where each content-feed family is stamped - the one place to read it, and the
 * one place to change it. A family's reads and writes both use its entry, so the
 * two can never split. An Etherna route's reads still ask our bee as well, so
 * moving a family never strands what it wrote before.
 */
export const FEED_ROUTES = {
  /** Profile data + avatar pointer (#617, #651). */
  profile: ETHERNA_ROUTE,
  /** Event detail feeds, for reads. Writes follow each event's own recorded gateway. */
  event: ETHERNA_ROUTE,
  /** The encrypted-to-self backup/feed manifest. */
  manifest: WOCO_ROUTE,
  /** Likes, follows, Interested, and their subject index. */
  social: WOCO_ROUTE,
  /** The referee's own referral statement and its subject index. */
  referral: WOCO_ROUTE,
  /** Referral confirmations and badges - written by the server's campaign issuer, read here. */
  campaignIssuer: WOCO_ROUTE,
  /** Recovery: the portability envelope, the escrow envelope, the guardian's account index. */
  recoveryPortability: WOCO_ROUTE,
  recoveryEnvelope: WOCO_ROUTE,
  guardianIndex: WOCO_ROUTE,
  /** Coaster laps and their indexes. Moves last: a wrong read restarts a lifetime count. */
  credits: WOCO_ROUTE,
  /** The certificate rail, outside launch scope. */
  cert: WOCO_ROUTE,
} as const satisfies Record<string, FeedRoute>;

/**
 * The route for a feed whose storage gateway is recorded ON it (events, sites).
 * That value is organiser-written, so only the Etherna host selects Etherna; the
 * rule is the server's own (`isEthernaGateway`, host suffix), so routing matches.
 */
export function feedRouteFor(gatewayUrl: string | undefined): FeedRoute {
  if (!gatewayUrl) return WOCO_ROUTE;
  try {
    return new URL(gatewayUrl).host.endsWith(new URL(ETHERNA_GATEWAY_URL).host) ? ETHERNA_ROUTE : WOCO_ROUTE;
  } catch {
    return WOCO_ROUTE;
  }
}
