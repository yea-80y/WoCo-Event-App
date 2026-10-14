/**
 * A door pass's secret P (#186, v2): derived from the account's CURRENT secret, the
 * event and the pass's own id - never random, never stored. Any of the organiser's
 * passkeys can show the pass or re-push the attendee list; a removed passkey, which
 * never sees the account's new secret, cannot work out P for a pass made after.
 *
 * The pass id is chosen HERE, so P and its door entries key exist before the server is
 * asked to issue the pass: one request issues it and registers the key, signed by the
 * account's content-feed signer (a login session alone cannot sign that).
 */
import { base64UrlEncode, decodeDoorPassToken } from "@woco/shared";
import { doorPassSecret } from "@woco/shared/keyring/account-secret";
import { doorKeyRefOf, doorKeyRegistrationMessage } from "@woco/shared/checkin/door-keys";
import { doorEntriesKeypair } from "@woco/shared/checkin/door-entries-key";
import { deriveFeedSignerKey } from "@woco/shared/crypto/feed-signer";
import { signPersonalMessage } from "@woco/shared/crypto/issuing";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/** A fresh pass id: 16 random bytes, lowercase hex (`DOOR_PASS_ID_RE`). */
export function newDoorPassId(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

/** P for an issued pass, for its link. The pass must be this event's. */
export function doorPassSecretB64url(secretHex: string, eventId: string, token: string): string {
  const decoded = decodeDoorPassToken(token);
  if (!decoded || decoded.payload.eventId !== eventId) throw new Error("This door pass isn't for this event - make a new one.");
  const secret = hexToBytes(secretHex.replace(/^0x/, ""));
  const p = doorPassSecret(secret, eventId, decoded.payload.jti);
  try {
    return base64UrlEncode(p);
  } finally {
    p.fill(0);
    secret.fill(0);
  }
}

/** What a new pass sends to be issued: its id, its door entries public key, and the
 *  content-feed signer's signature over them. Nothing secret leaves the device. */
export function doorPassRegistration(secretHex: string, eventId: string, passId: string): { jti: string; doorKey: string; sig: string } {
  const clean = secretHex.replace(/^0x/, "");
  const secret = hexToBytes(clean);
  const p = doorPassSecret(secret, eventId, passId);
  const priv = hexToBytes(deriveFeedSignerKey(clean).privKey.slice(2));
  try {
    const kp = doorEntriesKeypair(p);
    kp.secretKey.fill(0);
    const sig = signPersonalMessage(doorKeyRegistrationMessage(eventId, passId, doorKeyRefOf(kp.publicKey)), priv);
    return { jti: passId, doorKey: bytesToHex(kp.publicKey), sig };
  } finally {
    p.fill(0);
    secret.fill(0);
    priv.fill(0);
  }
}
