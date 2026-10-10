/**
 * Organising needs a passkey account (#746 step 5, owner decision 10-01).
 *
 * An organiser's attendee details are sealed to a key that comes from the
 * account's seed, and only a passkey roots that seed outside every email and
 * wallet key. The server refuses a wallet account at Stripe onboarding
 * (`routes/stripe.ts`) - it cannot tell a passkey smart account from an email
 * one, so this is the check for those: the organiser workspace opens only for a
 * passkey account. Dependency-free; it runs in the eager shell.
 */

export const ORGANISER_PASSKEY_MESSAGE =
  "Organising uses a passkey account. Create one to host events - this account keeps your tickets.";

/** Every passkey is lost = no way back in: said once, where an organiser signs up. */
export const PASSKEY_ONLY_RECOVERY_NOTE = "If every passkey is lost, the account can't be recovered.";

export function canOrganise(kind: string | null | undefined): boolean {
  return kind === "passkey";
}

/**
 * Whether a sign-in is an ORGANISER's, and so offers a passkey only. Decided by
 * where it was asked from, never by forking the modal: an explicit organiser
 * context ("invite" from Start hosting, "creator" from the organiser portal), or
 * a request with no context made anywhere in the organiser portal - every
 * organiser screen's own Sign in button. An explicit attendee or ticket context
 * keeps email, wherever it was asked from.
 */
export function isOrganiserSignIn(
  context: string | null | undefined,
  surface: string | null | undefined,
): boolean {
  if (context === "invite" || context === "creator") return true;
  return context == null && surface === "creator";
}
