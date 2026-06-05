/**
 * Sign-in-to-act gate. Composes the inline pattern repeated across the app
 * (loginRequest.request() → ensureSession() [→ ensureWocoSessionKey()]) into a
 * single awaitable guard a component can call before a privileged action.
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
  /**
   * Also ensure the passkey on-chain session key (gasless Kernel rail) is
   * minted up front — for deliberate on-chain actions like an EAS like, so the
   * passkey ceremony happens at the click, not mid-attest. No-op for non-passkey
   * kinds (web3 signs on-chain with the parent EOA directly).
   */
  onChain?: boolean;
}

export async function requireAccountForAction(
  opts: RequireAccountOptions = {},
): Promise<boolean> {
  // 1. Logged in (parent connected).
  if (!auth.isConnected) {
    const ok = await loginRequest.request(opts.context ? { context: opts.context } : undefined);
    if (!ok) return false;
  }

  // 2. HTTP session (canonical-request signing) — needed for authenticated
  //    server calls such as POST /api/likes/record.
  if (!auth.hasSession) {
    const ok = await auth.ensureSession();
    if (!ok) return false;
  }

  // 3. Passkey-only: pre-mint the scoped on-chain session key for gasless ops.
  if (opts.onChain && auth.kind === "passkey") {
    try {
      await auth.ensureWocoSessionKey();
    } catch {
      return false;
    }
  }

  return true;
}
