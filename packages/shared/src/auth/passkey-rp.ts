/**
 * Where WoCo passkeys live - ONE place, because the RP ID scopes the credential and
 * everything derives from the credential (PRF -> secp256k1 key -> Kernel address ->
 * identity seed): a credential under another RP ID is a whole different account.
 *
 * Every ceremony runs in the passkey sign-in window (apps/web/src/auth-window/), a
 * top-level page on the passkey host, opened from the app. The app never calls
 * WebAuthn, so it never resolves an RP ID: the window's own host IS the RP ID.
 */

/**
 * The passkey host and RP ID: `auth.woco.eth`, a real L1 subnode of woco.eth with its
 * own resolver (never our CCIP gateway), whose contenthash the owner's Safe pins.
 * FROZEN from launch.
 *
 * Not `woco.eth.limo`: `*.eth.limo` joined the Public Suffix List on 2026-09-01, which
 * made it a public suffix that Firefox refuses as an RP ID even on an exact match, and
 * every holder-run `<label>.woco.eth.limo` could claim it in a browser with an older
 * list. `auth.` is one label below the suffix (every engine accepts it) and a SIBLING
 * of every sub-name, so no sub-name can claim it in any browser.
 */
export const PASSKEY_PRODUCTION_RP_ID = "auth.woco.eth.limo";

/** The sign-in window's origin: every passkey ceremony runs there. */
export const PASSKEY_WINDOW_ORIGIN = `https://${PASSKEY_PRODUCTION_RP_ID}`;

/** The app's one origin: the only page the passkey sign-in window answers. */
export const WOCO_APP_ORIGIN = "https://woco.eth.limo";

/** Local development's pair: the app's dev server and the dev build of the window
 *  (`npm run dev:auth`). Never in a production artifact (vite-plugins/auth-window.ts). */
export const PASSKEY_DEV_APP_ORIGIN = "http://localhost:5173";
export const PASSKEY_DEV_WINDOW_ORIGIN = "http://localhost:5174";
