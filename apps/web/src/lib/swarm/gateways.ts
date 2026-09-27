import {
  ETHERNA_GATEWAY_URL,
  FEED_FAMILIES,
  FEED_FAMILY_STORES,
  WOCO_GATEWAY_URL,
  isEthernaGatewayUrl,
  type FeedFamily,
} from "@woco/shared";

/**
 * Canonical gateway URLs, from `@woco/shared` so client and server recognise the
 * same hosts (#657). Beyond being read endpoints, these are the ROUTING SIGNAL
 * for server-side batch selection: /api/swarm/soc, /api/swarm/bytes and the
 * site/event deploy endpoints match the gatewayUrl host to decide which postage
 * batch pays (the caller's Etherna batch when they own a live one, the shared
 * Etherna platform batch otherwise, the WoCo platform batch when the WoCo
 * gateway — or nothing — is sent).
 */
export { ETHERNA_GATEWAY_URL, WOCO_GATEWAY_URL };

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
 * Where each content-feed family is stamped: one route per row of the SHARED
 * table (`FEED_FAMILY_STORES`, packages/shared/src/swarm/feed-routes.ts), which
 * the server reads too (#657) - so a move is one line THERE, never here. A
 * family the CLIENT writes uses its route for reads and writes alike, so the two
 * cannot split. An Etherna route's reads still ask our bee as well, so moving a
 * family never strands what it wrote before.
 *
 * A move has a rollout window (#689): a tab still running the previous app
 * writes the family's next version to the OLD store, at the same address the new
 * app may use on the new one. Every read tries our gateway first, so if the old
 * store is ours, that copy wins and the other is never read. Close other tabs
 * after the frontend deploy. And the server goes first: its `/api/health`
 * `feedRoutes` must show the new row before this bundle ships.
 *
 * Some rows are not client-written, and the shared table says so: `event` and
 * `site` are read-only discovery routes (writes follow each feed's own recorded
 * gateway, `feedRouteFor`), and `campaignIssuer` / `evidence` are written by
 * the SERVER.
 */
export const FEED_ROUTES: { readonly [F in FeedFamily]: FeedRoute } = Object.freeze(
  Object.fromEntries(
    FEED_FAMILIES.map((family) => [
      family,
      familyRoute(family, FEED_FAMILY_STORES[family] === "etherna" ? ETHERNA_ROUTE : WOCO_ROUTE),
    ]),
  ) as { [F in FeedFamily]: FeedRoute },
);

/**
 * The route for a feed whose storage gateway is recorded ON it (events, sites,
 * shops). That value is organiser-written, so only the Etherna host selects
 * Etherna - the Etherna host or a subdomain of it, with a dot boundary. The rule
 * is shared with the server (`isEthernaGatewayUrl`, #657), so routing matches.
 *
 * `undefined` means WoCo: that is what a STORED feed without a gateway was
 * stamped on. (A create REQUEST without one means Etherna instead -
 * apps/server/src/lib/event/service.ts - which is why callers pass the recorded
 * value, never a guess.)
 */
export function feedRouteFor(gatewayUrl: string | undefined): FeedRoute {
  return isEthernaGatewayUrl(gatewayUrl) ? ETHERNA_ROUTE : WOCO_ROUTE;
}
