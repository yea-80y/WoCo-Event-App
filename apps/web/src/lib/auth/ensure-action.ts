/**
 * Sign-in-to-act gate. Composes the inline pattern repeated across the app
 * (loginRequest.request() → ensureSession()) into a single awaitable guard a
 * component can call before a privileged action.
 *
 * ADDITIVE only — this moves no component state and changes no existing call
 * sites (feedback_claimbutton_refactor_safety). LikeButton is the first
 * consumer; the gated-card flow reuses it via the existing
 * `CheckoutError { gated }` path.
 *
 * Returns true when the account is ready to act, false if the user cancelled
 * login / a required ceremony (caller should simply abort, no error UI).
 */

import { auth } from "./auth-store.svelte.js";
import { loginRequest } from "./login-request.svelte.js";

export interface RequireAccountOptions {
  /** Subtitle context for the login modal. */
  context?: "attendee" | "creator";
}

// An `onChain` option used to pre-mint a scoped Kernel session key here, so the
// passkey ceremony landed at the click rather than mid-write. Both keys it ever
// named are gone — the sub-ENS mint key with the permit rail (#501), the
// referral campaign's with the EAS rail (#476) — and every write the gate now
// guards is a signed Swarm record, which needs no on-chain key at all.

export async function requireAccountForAction(
  opts: RequireAccountOptions = {},
): Promise<boolean> {
  // 1. Logged in (parent connected).
  if (!auth.isConnected) {
    const ok = await loginRequest.request(opts.context ? { context: opts.context } : undefined);
    if (!ok) return false;
  }

  // 2. HTTP session (canonical-request signing) — every authenticated server
  //    endpoint verifies the session delegation.
  if (!auth.hasSession) {
    const ok = await auth.ensureSession();
    if (!ok) return false;
  }

  return true;
}
