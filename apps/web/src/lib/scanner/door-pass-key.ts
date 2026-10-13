/**
 * The door pass's roster key (#186): derived from the account's CURRENT secret, the
 * event and the pass's own id - never random, never stored. Any of the organiser's
 * passkeys can show the pass or re-push the attendee list; a removed passkey, which
 * never sees the account's new secret, cannot work out the key for a pass made after.
 * The pass is issued FIRST, since its id is part of the key.
 */
import { base64UrlEncode, decodeDoorPassToken } from "@woco/shared";
import { doorPassRosterKey } from "@woco/shared/keyring/account-secret";
import { hexToBytes } from "@noble/hashes/utils.js";

export function doorPassRosterKeyB64url(secretHex: string, eventId: string, token: string): string {
  const decoded = decodeDoorPassToken(token);
  if (!decoded || decoded.payload.eventId !== eventId) throw new Error("This door pass isn't for this event - make a new one.");
  const key = doorPassRosterKey(hexToBytes(secretHex.replace(/^0x/, "")), eventId, decoded.payload.jti);
  try {
    return base64UrlEncode(key);
  } finally {
    key.fill(0);
  }
}
