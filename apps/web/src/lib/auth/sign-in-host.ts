import { PASSKEY_APP } from "./passkey-window.js";

/**
 * True when this page must send the user to the app to sign in: every origin but the
 * app's own. The passkey window answers that one page only (passkey-window.ts), a name
 * host's sessions are refused by the server (host-label.ts), and the gateway host also
 * serves organisers' deployed sites, which would share the key storage of anyone signed
 * in on it (#186). Local development is the dev app on :5173, which the dev window answers.
 */
export function mustSignInElsewhere(origin: string): boolean {
  return origin !== PASSKEY_APP;
}
