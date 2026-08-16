/**
 * WebAuthn Relying Party ID resolution — ONE implementation on purpose.
 *
 * The RP ID scopes the credential, and everything derives from the credential
 * (PRF → secp256k1 key → Kernel address → POD identity), so a credential under
 * a different RP ID is a whole different account. apps/web and packages/embed
 * previously each carried a copy of this function, and the copies' shared
 * docstring ("falls back for localhost dev") described a fallback that in fact
 * applied to EVERY non-canonical host — which is how #175 survived review.
 */

export const PASSKEY_PRODUCTION_RP_ID = "woco.eth.limo";

/**
 * Resolve the RP ID for the document hostname.
 *
 * `woco.eth.limo` and its subdomains share the production RP ID, so every
 * surface served from the canonical origin sees the same credentials. EVERY
 * other hostname resolves to itself — localhost dev, but also any foreign
 * host. That is a WebAuthn constraint, not a choice: the RP ID must be a
 * registrable suffix of the document origin, so a page on `organiser.com`
 * cannot assert `woco.eth.limo`, and credentials minted under its own
 * hostname are invisible to the canonical origin (and vice versa). This is
 * why the embed must never CREATE passkeys on organiser domains (#175, #140)
 * — a passkey minted there can never be the user's WoCo account.
 */
export function resolvePasskeyRpId(hostname: string): string {
  if (
    hostname === PASSKEY_PRODUCTION_RP_ID ||
    hostname.endsWith(`.${PASSKEY_PRODUCTION_RP_ID}`)
  ) {
    return PASSKEY_PRODUCTION_RP_ID;
  }
  return hostname;
}
