import { PASSKEY_PRODUCTION_RP_ID, resolvePasskeyRpId } from "@woco/shared";
import { hostLabel } from "../sub-ens/host-label.js";

/**
 * True when this host must send the user to woco.eth.limo to sign in.
 *
 * A name host because the server refuses sessions from it (see host-label.ts).
 * Any other non-canonical host (#186) because a passkey made there is scoped to
 * that hostname, so it is a second account; and the gateway host also serves
 * organisers' deployed sites, which would share the key storage of anyone
 * signed in on it. Local development is exempt.
 */
export function mustSignInElsewhere(hostname: string, dev: boolean): boolean {
  if (hostLabel(hostname) !== null) return true;
  if (dev || hostname === "localhost" || hostname === "127.0.0.1") return false;
  return resolvePasskeyRpId(hostname) !== PASSKEY_PRODUCTION_RP_ID;
}
