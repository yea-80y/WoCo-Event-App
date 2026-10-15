/**
 * A door pass's secret P (#186, v2): derived from the account's CURRENT secret, the
 * event and the pass's own id - never random, never stored. Any of the organiser's
 * passkeys can show the pass or re-push the attendee list; a removed passkey, which
 * never sees the account's new secret, cannot work out P for a pass made after.
 *
 * The pass id is chosen HERE, so P and its door entries key exist before the server is
 * asked to issue the pass. Issuing takes proof that this device holds the account's
 * current ORDER key (`doorPassProof`): the server seals a nonce to it, and gets back only
 * an HMAC under that nonce. A login session alone cannot answer.
 */
import { base64UrlEncode, decodeDoorPassToken, type DoorPassChallenge } from "@woco/shared";
import { doorPassSecret } from "@woco/shared/keyring/account-secret";
import { doorKeyProof, doorKeyRefOf, type DoorKeyProofFields } from "@woco/shared/checkin/door-keys";
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

/** A new pass's id and door entries public key. Nothing secret leaves the device. */
export async function doorPassRegistration(
  secretHex: string,
  eventId: string,
  passId: string,
): Promise<{ jti: string; doorKey: string; doorKeyRef: string }> {
  // Lazy, like every X-Wing importer (xwing-lazy-load.test.ts): this module is in the
  // dashboard's chunk, and only making a pass needs the lattice code.
  const { doorEntriesKeypair } = await import("@woco/shared/checkin/door-entries-key");
  const secret = hexToBytes(secretHex.replace(/^0x/, ""));
  const p = doorPassSecret(secret, eventId, passId);
  try {
    const kp = doorEntriesKeypair(p);
    kp.secretKey.fill(0);
    return { jti: passId, doorKey: bytesToHex(kp.publicKey), doorKeyRef: doorKeyRefOf(kp.publicKey) };
  } finally {
    p.fill(0);
    secret.fill(0);
  }
}

type OpenBox = (secretKey: Uint8Array, box: unknown, ctx: { info: string; aad: string }) => Promise<Uint8Array>;

/**
 * Answer a door-pass challenge: open its nonce with the account's current order key and
 * return HMAC-SHA256(nonce, transcript). The nonce and the key are zeroed before this
 * returns, whatever happens; the nonce is never sent.
 */
export async function doorPassProof(
  secrets: { current: string },
  challenge: Pick<DoorPassChallenge, "challengeId" | "box">,
  fields: Omit<DoorKeyProofFields, "challengeId">,
  open?: OpenBox,
): Promise<string> {
  // Lazy, like every X-Wing importer (xwing-lazy-load.test.ts): only making a pass needs it.
  const [sealed, { deriveXWingKeypairFromSeed }] = await Promise.all([
    import("@woco/shared/crypto/sealed-box"),
    import("@woco/shared/crypto/xwing"),
  ]);
  const { secretKey } = deriveXWingKeypairFromSeed(secrets.current);
  let nonce: Uint8Array | null = null;
  try {
    nonce = await (open ?? sealed.openBox)(secretKey, challenge.box, sealed.doorKeyProofSealContext(fields.eventId, fields.parent, challenge.challengeId));
    if (nonce.length !== 32) throw new Error("This door pass request didn't check out - reload the page and try again.");
    return doorKeyProof(nonce, { ...fields, challengeId: challenge.challengeId });
  } finally {
    nonce?.fill(0);
    secretKey.fill(0);
  }
}
