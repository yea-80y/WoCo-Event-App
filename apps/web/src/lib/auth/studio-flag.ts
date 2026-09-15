/**
 * Whether this device has seen the account act as an organiser: a Stripe
 * account, an event, a site, or a tap on "Start hosting".
 *
 * It only decides what the member shell OFFERS (a Studio link in the top bar).
 * Nothing is gated on it — every organiser route and API still checks for
 * itself — so a stale or missing flag costs a link, never access.
 *
 * Dependency-free, so it runs under the plain-tsx suite and costs the boot
 * chunk a few lines.
 */

const PREFIX = "woco:studio:";

function key(parent: string): string {
  return `${PREFIX}${parent.toLowerCase()}`;
}

export function markStudio(parent: string | null | undefined): void {
  if (!parent) return;
  // Only the storage call sits inside the try: a missing account is handled by
  // the guard above, not by swallowing whatever `key` would throw.
  const storageKey = key(parent);
  try {
    globalThis.localStorage?.setItem(storageKey, "1");
  } catch {
    // Storage blocked: the Studio link stays hidden, which is all this costs.
  }
}

export function hasStudio(parent: string | null | undefined): boolean {
  if (!parent) return false;
  const storageKey = key(parent);
  try {
    return globalThis.localStorage?.getItem(storageKey) === "1";
  } catch {
    return false;
  }
}
