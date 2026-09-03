/**
 * Display verification for sub-ENS names (plan doc §3 point F).
 *
 * WHY THIS EXISTS. Every place the app shows `{label}.woco.eth` reads that
 * label out of a FEED — an event feed, a profile feed. Under Phase B those
 * feeds are CLIENT-signed, so the label is the author's own claim and nothing
 * verified it: a modified client can put any label into its own profile SOC and
 * every viewer will render it. The name is an identity badge, so that is
 * impersonation. It also has a mundane twin — two events still display names
 * from a registry that no longer exists (`finaltest`, `testevent`), and there
 * is no way to write to those client-signed feeds to clear them.
 *
 * Both are fixed by refusing to RENDER a name whose on-chain owner is not the
 * address we expect. Nothing is written; the dead names simply stop appearing.
 *
 * FAIL-CLOSED, WITH A LAST-GOOD VERDICT. `GET /api/sub-ens/check/:label` is
 * public, unauthenticated and RPC-backed, so an attacker who can push it to 500
 * — exhausting the RPC quota is enough — would, under a fail-open rule, get
 * their forged claim rendered for everyone. So an unanswered check renders
 * nothing. The cost of that strictness is bounded by keeping the last DEFINITIVE
 * verdict for a day: an outage only affects the first-ever paint of a name on a
 * device, not names the viewer has already seen.
 *
 * Absence and failure are different answers and are kept apart by
 * `resolveSubEnsWith` (#177) rather than re-derived here.
 */

import { resolveSubEnsWith } from "../api/sub-ens-resolve.js";
import { cacheGet, cacheSet } from "../cache/cache.js";
import { verdictAllows, verdictIsFresh, type OwnerVerdict } from "./name-verdict.js";

export { verdictAllows, verdictIsFresh, type OwnerVerdict } from "./name-verdict.js";

/** Eviction. A verdict older than this is forgotten entirely and the name goes
 *  back to hidden-until-checked. */
const EVICT_SECONDS = 24 * 60 * 60;

const key = (label: string): string => `subens-owner:${label.toLowerCase()}`;

/** The remembered verdict for a label, or null when we have never had one. */
export function cachedVerdict(label: string): OwnerVerdict | null {
  return cacheGet<OwnerVerdict>(key(label));
}

/**
 * What to paint RIGHT NOW, with no network: true to show the name, false to
 * hide it. False covers "we have never checked" as well as "checked and wrong"
 * — deliberately, because painting an unverified claim even briefly is what
 * gives the impersonation its value. An "unverified" badge is not an
 * alternative: people do not read badges.
 */
export function nameIsVerified(label: string, expected: string | null | undefined): boolean {
  return verdictAllows(cachedVerdict(label), expected);
}

/** label → in-flight check, so one creator rendered by several components at
 *  once (an event card, its chip, the profile) issues a single request. */
const inFlight = new Map<string, Promise<OwnerVerdict | null>>();

/**
 * Fetch and remember the owner of `label`.
 *
 * Returns the verdict, or null when nobody answered — in which case NOTHING is
 * written, so a previously cached verdict survives an outage untouched.
 */
export async function refreshVerdict(label: string): Promise<OwnerVerdict | null> {
  const k = key(label);
  const existing = inFlight.get(k);
  if (existing) return existing;

  const run = (async (): Promise<OwnerVerdict | null> => {
    const { checkSubEnsLabel } = await import("../api/sub-ens.js");
    const res = await resolveSubEnsWith(checkSubEnsLabel, label);
    if (res.status === "error") return null; // not a verdict — keep what we have
    const verdict: OwnerVerdict = {
      owner: res.status === "found" ? res.address.toLowerCase() : null,
      checkedAt: Date.now(),
    };
    cacheSet(k, verdict, EVICT_SECONDS);
    return verdict;
  })().finally(() => inFlight.delete(k));

  inFlight.set(k, run);
  return run;
}

/**
 * Verify `label` belongs to `expected`, using the cache and revalidating when
 * the entry is stale. The single call site for a component.
 */
export async function verifyName(label: string, expected: string | null | undefined): Promise<boolean> {
  if (!label || !expected) return false;
  const cached = cachedVerdict(label);
  if (verdictIsFresh(cached)) return verdictAllows(cached, expected);
  const fresh = await refreshVerdict(label);
  // A failed lookup falls back to whatever we already believed, which may be
  // nothing — never to "show it anyway".
  return verdictAllows(fresh ?? cached, expected);
}

/**
 * Record a verdict the client already knows first-hand — after a successful
 * bind, stamp or `/owned` read, where the server confirmed ownership on-chain.
 * Saves the viewer's own first paint from waiting on a round trip.
 */
export function rememberOwner(label: string, owner: string | null): void {
  cacheSet<OwnerVerdict>(key(label), { owner: owner?.toLowerCase() ?? null, checkedAt: Date.now() }, EVICT_SECONDS);
}
