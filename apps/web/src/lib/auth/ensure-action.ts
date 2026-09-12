/**
 * Sign-in-to-act gate. Composes the inline pattern repeated across the app
 * (loginRequest.request() → ensureSession() [→ ensureEasSessionKey()]) into a
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
   * Also ensure the scoped EAS session key (the gasless Kernel rail) is minted
   * up front — for a deliberate on-chain action like a referral confirmation, so
   * the passkey
   * ceremony happens at the click, not mid-attest. No-op for non-passkey kinds
   * (web3 signs on-chain with the parent EOA directly).
   *
   * It used to pre-mint the sub-ENS `registerWithPermit` key, which is not the
   * key an attestation is signed with — so the ceremony happened at the click
   * for a key nothing then used, and the EAS key was still minted mid-attest.
   * That key is gone with the permit rail (#501); this now names the one the
   * attest actually needs.
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

  // 2. HTTP session (canonical-request signing) — every authenticated server
  //    endpoint verifies the session delegation.
  if (!auth.hasSession) {
    const ok = await auth.ensureSession();
    if (!ok) return false;
  }

  // 3. Passkey-only: pre-mint the scoped EAS session key for gasless ops.
  if (opts.onChain && auth.kind === "passkey") {
    try {
      await auth.ensureEasSessionKey();
    } catch {
      return false;
    }
  }

  return true;
}
