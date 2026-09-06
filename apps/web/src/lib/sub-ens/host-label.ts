/**
 * A WoCo name resolves, through our CCIP gateway, to the WoCo app's own Swarm
 * content — so a browser at `nabil.woco.eth.link` loads THIS app. Two things
 * follow, and both are decided here as pure functions so they can be tested
 * without a DOM:
 *
 *  1. The app must open that person's profile rather than its own home page.
 *  2. It must not offer to sign in. `ALLOWED_HOSTS` deliberately excludes
 *     `*.woco.eth.<tld>`: a SITE name serves holder-chosen content under the
 *     same suffix, so a wildcard would let attacker content run on an allowed
 *     origin and mint sessions. The CTA therefore sends the user to the
 *     canonical app host, where login is allowed.
 */

/** Matches `<label>.woco.eth.<gateway-tld>` — one label only. `x.y.woco.eth.link`
 *  is NOT a name host: `[a-z0-9-]+` cannot span the dot, so a deeper subdomain
 *  (which nothing in the registrar can mint) falls through to the normal app. */
const NAME_HOST = /^([a-z0-9-]+)\.woco\.eth\.[a-z]+$/;

/** The label a name host carries, or null when the hostname is not one. */
export function hostLabel(hostname: string): string | null {
  const match = hostname.toLowerCase().match(NAME_HOST);
  return match ? match[1] : null;
}

/**
 * Where sign-in works. A literal, not an import: no shared sub-ENS constant
 * carries the APEX app origin today (`packages/shared/src/sub-ens/addresses.ts`
 * holds chain addresses only), and this module is on the boot path — pulling a
 * creator-side module in for one string would drag its graph with it.
 */
export const CANONICAL_APP_ORIGIN = "https://woco.eth.limo";

/** The same screen on the canonical host. `hash` is `location.hash` — already
 *  `#`-prefixed, or empty for the home route. */
export function canonicalUrl(hash: string): string {
  return `${CANONICAL_APP_ORIGIN}/${hash}`;
}

/**
 * The label whose profile a fresh load should open, or null to leave the route
 * alone. Only the DEFAULT route redirects: a name host reached with a real
 * route (a shared `#/event/…` link, say) is a deliberate destination, and
 * stealing it would break every link anyone posts.
 */
export function bootRedirectFor(hostname: string, hash: string): string | null {
  const label = hostLabel(hostname);
  if (!label) return null;
  return hash === "" || hash === "#" || hash === "#/" ? label : null;
}
