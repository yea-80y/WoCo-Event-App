// ---------------------------------------------------------------------------
// Swarm feed topic derivation for the POD layer (manager + holdings)
// ---------------------------------------------------------------------------
//
// Centralised so the server (writer) and any reader (creator POD manager, gate
// checks) agree on the exact strings. Mirrors `shop/topics.ts` and
// `apps/server/src/lib/swarm/topics.ts`. Ticket/edition/collection topics for
// the existing flow live in the server `topics.ts`; this file adds only the
// new creator-facing POD directory.
//
// IMPORTANT: these strings are stable — changing them changes the feed address.

/**
 * A creator's POD directory — every POD *type* (manifest) they have issued,
 * across all kinds (ticket / badge / collectible / authenticity). This is what
 * the `#/creator/pods` manager reads. Paged like `ShopDirectory`: page 0 holds
 * the head + category list, overflow spills to `/pN`.
 */
export function podCreatorDirectoryTopic(ethAddress: string, page = 0): string {
  const base = `woco/pod/creator/${ethAddress.toLowerCase()}`;
  return page === 0 ? base : `${base}/p${page}`;
}
