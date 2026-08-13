/**
 * Global session-health flag (#256).
 *
 * True only after the server rejected a FRESHLY-MINTED delegation — the point
 * where client.ts stops retrying because re-signing provably cannot fix this
 * session (owner rotated away, host not allowed, session revoked). From that
 * moment every authenticated read is unverifiable, and without one shared
 * fact the screens each render their failure as a negative state ("no
 * events", "verify with Stripe") — a recoverable situation that reads as
 * data loss.
 *
 * Written from exactly one place (client.ts's recovery-suppression branch) so
 * true always means "proven", never "some request failed". Cleared the moment
 * any authenticated request succeeds; the banner's sign-in path reloads the
 * app instead, so nothing painted from the dead session survives.
 */

let _ended = $state(false);

export const sessionHealth = {
  get ended(): boolean {
    return _ended;
  },
  markEnded(): void {
    _ended = true;
  },
  clear(): void {
    _ended = false;
  },
};
