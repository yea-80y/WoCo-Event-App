// ---------------------------------------------------------------------------
// Swarm feed topic derivation for the object layer (manager + holdings)
// ---------------------------------------------------------------------------
//
// Centralised so the server (writer) and any reader (creator object manager, gate
// checks) agree on the exact strings. Mirrors `shop/topics.ts` and
// `apps/server/src/lib/swarm/topics.ts`. Ticket/edition/collection topics for
// the existing flow live in the server `topics.ts`; this file adds only the
// new creator-facing object directory.
//
// IMPORTANT: these strings are stable — changing them changes the feed address.

/**
 * A creator's object directory — every object *type* (manifest) they have issued,
 * across all kinds (ticket / badge / collectible / authenticity). This is what
 * the `#/creator/objects` manager reads. Page 0 holds the head + category list;
 * overflow is one immutable blob it names (#950). `/pN` held overflow before that.
 */
export function objectCreatorDirectoryTopic(ethAddress: string, page = 0): string {
  const base = `woco/object/creator/${ethAddress.toLowerCase()}`;
  return page === 0 ? base : `${base}/p${page}`;
}
