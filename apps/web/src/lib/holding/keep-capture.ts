/**
 * The Keep link's secret leaves the address bar at once (spec-receipt-note 5.2, Fable
 * condition 2). A ticket email links to `#/keep?k=<secret>&b=<box root>`; the router runs
 * this before it reads the hash, so the address bar, Back and a bookmark show `#/keep`
 * only. The fragment is held here, in memory, until the Keep page takes it.
 *
 * EAGER (the router imports it), so it imports nothing and does nothing else: no
 * parsing, no storage, no network. Mail scanners open links; opening one must do nothing
 * a person did not ask for.
 */

export const KEEP_ROUTE = "#/keep";
const KEEP_LINK_PREFIX = `${KEEP_ROUTE}?`;

let held: string | null = null;
const listeners = new Set<() => void>();

/**
 * When the address holds a Keep link: put `#/keep` in its place (no new history entry)
 * and return the fragment it held. Anything else: null, untouched.
 */
export function stripKeepLink(loc: Pick<Location, "hash" | "href">, replace: (url: string) => void): string | null {
  if (!loc.hash.startsWith(KEEP_LINK_PREFIX)) return null;
  const fragment = loc.hash;
  const at = loc.href.indexOf("#");
  replace(`${at === -1 ? loc.href : loc.href.slice(0, at)}${KEEP_ROUTE}`);
  return fragment;
}

/** Hold a stripped fragment for the Keep page, and tell a page already open. */
export function holdKeepLink(fragment: string): void {
  held = fragment;
  for (const l of listeners) l();
}

/** The held fragment, once: it is not kept here after the page has it. */
export function takeKeepLink(): string | null {
  const f = held;
  held = null;
  return f;
}

/** Called when a link arrives while the page is open (pasted into the same tab). */
export function onKeepLink(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
