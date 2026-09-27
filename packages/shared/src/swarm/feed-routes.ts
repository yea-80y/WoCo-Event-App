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

/**
 * Which Etherna batch pays when our relay stamps a family's chunk there.
 *
 * `owner`: the signed-in account's own batch while it is live, else the shared
 * platform batch - how every Etherna write has always been routed.
 *
 * `platform`: the shared platform batch, even for an account with a batch of its
 * own (#689). For recovery material the account that pays is neither the key that
 * owns the feed nor the person hurt when it vanishes: a lapsed hosting plan would
 * take the escrow with it, and nothing alarms on a user's batch, so the loss is
 * found at lock-out. And the guardian index is written by EVERY account one backup
 * protects - on their own batches its versions would spread across several, one
 * lapse would leave a gap, and a scan stops at the first gap. The platform batch is
 * the one whose life is watched (`/api/health` postage, #610).
 *
 * The WoCo store has one batch, so `stamp` only matters for an Etherna row.
 */
export type FeedStamp = "owner" | "platform";

export interface FeedFamilyPolicy {
  readonly store: FeedStore;
  readonly stamp: FeedStamp;
}

export const FEED_FAMILY_POLICY = {
  /** Profile data + avatar pointer (#617, #651). Client-written. */
  profile: { store: "etherna", stamp: "owner" },
  /**
   * Reading event detail feeds - a DISCOVERY row. New events are stamped on
   * Etherna and older ones on WoCo, and which one is recorded INSIDE the feed,
   * so a reader has to ask both. Writes follow each event's own recorded
   * gateway, never this row.
   */
  event: { store: "etherna", stamp: "owner" },
  /** Reading a site's client-signed config - a discovery row, like `event`. */
  site: { store: "etherna", stamp: "owner" },
  /** The encrypted-to-self backup/feed manifest (#689). Client-written. */
  manifest: { store: "etherna", stamp: "owner" },
  /** Likes, follows, Interested, and their subject index (#689). Client-written. */
  social: { store: "etherna", stamp: "owner" },
  /** The referee's own referral statement and its subject index (#689). Client-written;
   *  the server's issuer reads it before it countersigns. */
  referral: { store: "etherna", stamp: "owner" },
  /** Referral confirmations, badges and the referrer index. SERVER-written by the
   *  campaign issuer, read by clients - always on the platform batch. */
  campaignIssuer: { store: "woco", stamp: "platform" },
  /** Recovery: the portability envelope, the escrow envelope, the guardian's account
   *  index. Always the platform batch - see {@link FeedStamp}. */
  recoveryPortability: { store: "etherna", stamp: "platform" },
  recoveryEnvelope: { store: "etherna", stamp: "platform" },
  guardianIndex: { store: "etherna", stamp: "platform" },
  /** Coaster laps and their indexes. Moves last: a wrong read restarts a lifetime count. */
  credits: { store: "woco", stamp: "owner" },
  /** The certificate rail, outside launch scope. */
  cert: { store: "woco", stamp: "owner" },
  /** The social indexer's published evidence reports (#312). SERVER-written platform
   *  output - always on the platform batch. */
  evidence: { store: "woco", stamp: "platform" },
} as const satisfies Record<string, FeedFamilyPolicy>;

export type FeedFamily = keyof typeof FEED_FAMILY_POLICY;

export const FEED_FAMILIES = Object.freeze(Object.keys(FEED_FAMILY_POLICY) as FeedFamily[]);

function policyColumn<K extends keyof FeedFamilyPolicy>(
  column: K,
): { readonly [F in FeedFamily]: (typeof FEED_FAMILY_POLICY)[F][K] } {
  return Object.freeze(
    Object.fromEntries(FEED_FAMILIES.map((f) => [f, FEED_FAMILY_POLICY[f][column]])),
  ) as { readonly [F in FeedFamily]: (typeof FEED_FAMILY_POLICY)[F][K] };
}

/** Where each family is stamped - the column readers and `/api/health` `feedRoutes` use. */
export const FEED_FAMILY_STORES = policyColumn("store");

/** Which batch pays for each family's relayed writes - `/api/health` `feedStamps`. */
export const FEED_FAMILY_STAMPS = policyColumn("stamp");

/**
 * The stamp policy for a family NAME a client sent with a write. The name is the
 * client's word: the identifier is a hash and a portability or guardian-index
 * owner is a key the server never sees, so it cannot be checked - and it need not
 * be. It can only pick the platform batch, which every account without a live
 * batch of its own already writes to, under the same relay limits. Anything that
 * is not a family is `owner`, today's routing.
 */
export function feedStampForName(name: unknown): FeedStamp {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(FEED_FAMILY_POLICY, name)
    ? FEED_FAMILY_POLICY[name as FeedFamily].stamp
    : "owner";
}

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
