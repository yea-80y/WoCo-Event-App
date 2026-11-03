/**
 * Who in this tab is reading orders in the foreground (#201). The gateway's bundle
 * allowance and the public RPC are per IP, so an open dashboard and the audience
 * sync reading the same 20k orders at once would each get half. The dashboard
 * registers itself; the sync waits while any registered reader is busy, before its
 * chain read and between its bundles (detail-queue.ts `holdWhile`).
 *
 * Other tabs and devices are not seen here: for them the sync's larger headroom on
 * the gateway's RateLimit headers is the rule.
 */
const foreground = new Set<() => boolean>();

/** `busy` is asked whenever the sync would read; returns the unregister. */
export function registerForeground(busy: () => boolean): () => void {
  foreground.add(busy);
  return () => {
    foreground.delete(busy);
  };
}

/** A foreground reader in this tab is reading now. A predicate that throws counts as idle. */
export function foregroundBusy(): boolean {
  for (const busy of foreground) {
    try {
      if (busy()) return true;
    } catch {
      /* a broken predicate must never hold the sync for good */
    }
  }
  return false;
}
