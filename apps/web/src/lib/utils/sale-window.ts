/**
 * Client-side series sale-window status (#295).
 *
 * The server now ENFORCES `saleStart`/`saleEnd` on create-checkout and reserve
 * (apps/server/src/lib/event/series-window.ts); this helper keeps the main
 * app's buy UI in agreement so a refusal never 409s a button the page still
 * shows. Semantics match the deployed-site runtime's `saleStatus`
 * (EventPage.svelte, which keeps its own copy — the multisite bundle ships
 * separately and republishing every organiser site is not worth deduping four
 * lines): absent/empty fields are no constraint; an unparseable date renders
 * as no constraint here while the SERVER refuses it — the money path refuses
 * what it cannot verify, and well-formed producers make that unreachable.
 */

export type SeriesSaleStatus = "active" | "future" | "past";

export function seriesSaleStatus(
  s: { saleStart?: string; saleEnd?: string },
  now: number = Date.now(),
): SeriesSaleStatus {
  if (s.saleStart && new Date(s.saleStart).getTime() > now) return "future";
  if (s.saleEnd && new Date(s.saleEnd).getTime() < now) return "past";
  return "active";
}

/** Short "opens at" stamp for the not-yet-on-sale row. */
export function formatSaleDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
