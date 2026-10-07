/**
 * Carrying a page's `#/route` through an Android intent, which cannot hold a
 * fragment, and putting it back (#812). Eager - the router runs it before its
 * first read of the hash - so it stays this small; detection and the link
 * builder are lazy (`in-app-browser.ts`, `in-app-escape.ts`).
 */

/** Query parameter that carries the `#/route` across an Android intent, which
 *  cannot hold a fragment (`#Intent;...` takes its place). */
export const ESCAPE_ROUTE_PARAM = "woco-open";
/** Set on the fallback page an Android intent loads when Chrome is not there. */
export const ESCAPE_FAILED_PARAM = "woco-escape";

/**
 * The routes an Android intent may carry. A fragment never leaves the browser,
 * but the intent moves the route into the QUERY, which the host's server and
 * CDN receive and log. So only fixed path shapes that hold nothing private
 * qualify, and never a query inside the hash (`#/signup?gt=...` carries a gate
 * token). Anything else gets no intent: the manual "Open in browser" steps
 * reopen the page with its fragment untouched.
 */
const CARRIABLE_ROUTE =
  /^#\/(?:|home|discover|tickets|my-tickets|profile|passkeys|about|signup|legal(?:\/[a-z-]+)?|profile\/0x[0-9a-fA-F]{40}|ref\/[A-Za-z0-9._-]+|event\/[A-Za-z0-9_-]+(?:\/purchased)?|creator(?:\/[A-Za-z0-9_-]+)*)$/;

export function isCarriableRoute(hash: string): boolean {
  return CARRIABLE_ROUTE.test(hash);
}

/**
 * Put back the `#/route` an Android intent carried in the query, before the
 * router first reads the hash. Only a `#/...` route is accepted; the parameter
 * is always removed so a shared link never carries it on.
 */
export function restoreEscapedRoute(loc: Pick<Location, "href">, replace: (url: string) => void): void {
  let url: URL;
  try {
    url = new URL(loc.href);
  } catch {
    return;
  }
  const carried = url.searchParams.get(ESCAPE_ROUTE_PARAM);
  if (carried === null) return;
  url.searchParams.delete(ESCAPE_ROUTE_PARAM);
  if (isCarriableRoute(carried) && !url.hash) url.hash = carried;
  replace(url.href);
}
