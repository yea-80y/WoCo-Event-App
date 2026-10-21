/**
 * WebAuthn Relying Party ID resolution — ONE implementation on purpose.
 *
 * The RP ID scopes the credential, and everything derives from the credential
 * (PRF → secp256k1 key → Kernel address → identity seed), so a credential under
 * a different RP ID is a whole different account. apps/web and packages/embed
 * previously each carried a copy of this function, and the copies' shared
 * docstring ("falls back for localhost dev") described a fallback that in fact
 * applied to EVERY non-canonical host — which is how #175 survived review.
 */

export const PASSKEY_PRODUCTION_RP_ID = "woco.eth.limo";

/** The app's one origin: the only page the passkey sign-in window answers. */
export const WOCO_APP_ORIGIN = "https://woco.eth.limo";

/** Where every passkey ceremony runs: a window on `auth.woco.eth`, an L1 name with its
 *  own resolver, opened from the app. */
export const PASSKEY_WINDOW_ORIGIN = "https://auth.woco.eth.limo";

/** Local development's pair: the app's dev server and the dev build of the window
 *  (`npm run dev:auth`). Never in a production artifact (vite-plugins/auth-window.ts). */
export const PASSKEY_DEV_APP_ORIGIN = "http://localhost:5173";
export const PASSKEY_DEV_WINDOW_ORIGIN = "http://localhost:5174";

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
