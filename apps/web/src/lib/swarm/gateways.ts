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

/** Type-only brand: only this module can mint a FeedRoute. */
declare const feedRouteBrand: unique symbol;

/**
 * Where a content feed is stamped, and so which node must be asked about it.
 *
 * REQUIRED on every content-feed read and write, with no default: a feed read
 * from one store and written to another resolves its PREVIOUS version as current,
 * and a rewrite built on that erases the newer one (#651). An omitted optional
 * argument is how that happened, so omission no longer compiles. BRANDED, so a
 * route cannot be made up at a call site either (`{ gatewayUrl: "" }` does not
 * compile): every route comes from this module. Whether a read may trust "not
 * found" is a property of the call instead (`thorough`).
 */
export interface FeedRoute {
  readonly gatewayUrl: string;
  /** The label the user's manifest records for data stamped this way. */
  readonly target: "etherna" | "woco";
  /** Which family this route belongs to. Each family has its OWN route object, so
   *  a call that reads through another family's route is detectable even while
   *  both are stamped in the same place. */
  readonly family: string;
  readonly [feedRouteBrand]: true;
}
/** Feeds whose gateway is recorded on the feed itself - see `feedRouteFor`. */
export const ETHERNA_ROUTE = Object.freeze({ gatewayUrl: ETHERNA_GATEWAY_URL, target: "etherna", family: "etherna" }) as FeedRoute;
export const WOCO_ROUTE = Object.freeze({ gatewayUrl: WOCO_GATEWAY_URL, target: "woco", family: "woco" }) as FeedRoute;

function familyRoute(family: string, store: FeedRoute): FeedRoute {
  return Object.freeze({ gatewayUrl: store.gatewayUrl, target: store.target, family }) as FeedRoute;
}

/**
 * Where each content-feed family is stamped - the one place to read it, and the
 * one place to change it. A family the CLIENT writes uses its entry for reads and
 * writes alike, so the two cannot split. An Etherna route's reads still ask our
 * bee as well, so moving a family never strands what it wrote before.
 *
 * Two rows are not that shape, and say so: `event` is a read-only discovery
 * route (writes follow each event's own recorded gateway, `feedRouteFor`), and
 * `campaignIssuer` is written by the SERVER, whose choice must move with this row
 * when it moves.
 */
export const FEED_ROUTES = {
  /** Profile data + avatar pointer (#617, #651). */
  profile: familyRoute("profile", ETHERNA_ROUTE),
  /**
   * Reading event detail feeds. New events are stamped on Etherna and older ones
   * on WoCo; an Etherna route asks both, so it reads either. WRITES are not taken
   * from here: each event names its own gateway (`feedRouteFor(feed.gatewayUrl)`).
   */
  event: familyRoute("event", ETHERNA_ROUTE),
  /** The encrypted-to-self backup/feed manifest. */
  manifest: familyRoute("manifest", WOCO_ROUTE),
  /** Likes, follows, Interested, and their subject index. */
  social: familyRoute("social", WOCO_ROUTE),
  /** The referee's own referral statement and its subject index. */
  referral: familyRoute("referral", WOCO_ROUTE),
  /**
   * Referral confirmations and badges. Written by the SERVER's campaign issuer
   * (apps/server/src/lib/campaign/issuer.ts), only read here - change both sides
   * together.
   */
  campaignIssuer: familyRoute("campaignIssuer", WOCO_ROUTE),
  /** Recovery: the portability envelope, the escrow envelope, the guardian's account index. */
  recoveryPortability: familyRoute("recoveryPortability", WOCO_ROUTE),
  recoveryEnvelope: familyRoute("recoveryEnvelope", WOCO_ROUTE),
  guardianIndex: familyRoute("guardianIndex", WOCO_ROUTE),
  /** Coaster laps and their indexes. Moves last: a wrong read restarts a lifetime count. */
  credits: familyRoute("credits", WOCO_ROUTE),
  /** The certificate rail, outside launch scope. */
  cert: familyRoute("cert", WOCO_ROUTE),
} as const satisfies Record<string, FeedRoute>;

/**
 * The route for a feed whose storage gateway is recorded ON it (events, sites,
 * shops). That value is organiser-written, so only the Etherna host selects
 * Etherna; the rule is the server's own (`isEthernaGateway`, host suffix), so
 * routing matches.
 *
 * `undefined` means WoCo: that is what a STORED feed without a gateway was
 * stamped on. (A create REQUEST without one means Etherna instead -
 * apps/server/src/lib/event/service.ts - which is why callers pass the recorded
 * value, never a guess.)
 */
export function feedRouteFor(gatewayUrl: string | undefined): FeedRoute {
  if (!gatewayUrl) return WOCO_ROUTE;
  try {
    return new URL(gatewayUrl).host.endsWith(new URL(ETHERNA_GATEWAY_URL).host) ? ETHERNA_ROUTE : WOCO_ROUTE;
  } catch {
    return WOCO_ROUTE;
  }
}
