// ---------------------------------------------------------------------------
// Swarm feed topic derivation for shops
// ---------------------------------------------------------------------------
//
// Centralised so server (writer) and any reader (web shop / POS) agree on the
// exact strings. Mirrors `site/topics.ts` and `apps/server/src/lib/swarm/topics.ts`.
// IMPORTANT: these strings are stable — changing them changes the feed address.

/** Feed topic holding the `Shop` JSON (config + theme + payment rails). */
export function shopConfigTopic(shopId: string): string {
  return `woco/shop/config/${shopId}`;
}

/** Feed topic holding the paged `ProductsIndex` catalog for a shop. */
export function shopProductsTopic(shopId: string, page = 0): string {
  const base = `woco/shop/${shopId}/products`;
  return page === 0 ? base : `${base}/p${page}`;
}

/** Feed topic holding the paged `OrdersLog` for a shop. */
export function shopOrdersTopic(shopId: string, page = 0): string {
  const base = `woco/shop/${shopId}/orders`;
  return page === 0 ? base : `${base}/p${page}`;
}

/** Feed topic for a merchant's shop directory (all shops they own). */
export function shopCreatorDirectoryTopic(ethAddress: string, page = 0): string {
  const base = `woco/shop/creator/${ethAddress.toLowerCase()}`;
  return page === 0 ? base : `${base}/p${page}`;
}
