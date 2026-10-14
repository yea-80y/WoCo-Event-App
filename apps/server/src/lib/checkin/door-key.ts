/**
 * The door entries key a new door pass registers (live door attendee list).
 *
 * The server seals every later sale's email and card name to this key, so it must be
 * the ORGANISER's: the registration is personal-signed by the account's content-feed
 * signer, which comes from the account secret. A login session alone cannot produce
 * it - before this check, a stolen session could have registered its own key and been
 * handed every later buyer, where today it can read no attendee data at all.
 *
 * The signer is the one `eventKeys` names for the event (the key ring's, or the record
 * pinned at create), so a passkey removed since cannot register one either. What the
 * signature cannot prove is that the key derives from the pass secret - but whoever
 * holds the account secret can read every order anyway.
 */

import { hexToBytes } from "@noble/hashes/utils.js";
import { DOOR_PASS_ID_RE, doorKeyRefOf, doorKeyRegistrationMessage } from "@woco/shared/checkin/door-keys";
import { isValidXWingPublicKey, XWING_PUBLIC_KEY_BYTES } from "@woco/shared/crypto/xwing";
import { recoverPersonalSigner } from "@woco/shared/crypto/issuing";
import type { EventKeys } from "../keyring/event-keys.js";

export type DoorKeyRegistration =
  | { ok: true; jti: string; doorKey: string; doorKeyRef: string; gen: number }
  | { ok: false; status: 400 | 409 | 503; error: string };

const DOOR_KEY_RE = new RegExp(`^[0-9a-f]{${XWING_PUBLIC_KEY_BYTES * 2}}$`);
const OUTDATED_PAGE = "This page needs updating to make door passes - reload it and try again";

/**
 * @param idUsed whether this event has ever had a pass with this id: an old signed
 *   statement must not bring back an old pass, whose link may be out there.
 */
export function checkDoorKeyRegistration(
  eventId: string,
  body: { jti?: unknown; doorKey?: unknown; sig?: unknown } | undefined,
  keys: EventKeys,
  idUsed: (jti: string) => boolean,
): DoorKeyRegistration {
  const { jti, doorKey, sig } = body ?? {};
  if (typeof jti !== "string" || !DOOR_PASS_ID_RE.test(jti)) return { ok: false, status: 400, error: OUTDATED_PAGE };
  if (typeof doorKey !== "string" || !DOOR_KEY_RE.test(doorKey) || !isValidXWingPublicKey(hexToBytes(doorKey))) {
    return { ok: false, status: 400, error: OUTDATED_PAGE };
  }
  if (typeof sig !== "string") return { ok: false, status: 400, error: OUTDATED_PAGE };
  if (keys.kind === "legacy") {
    return {
      ok: false,
      status: 409,
      error: "This event was created before door passes were tied to your account's keys - create the event again to use the door scanner",
    };
  }
  if (keys.kind === "unavailable") {
    return { ok: false, status: 503, error: "Couldn't check your account's keys right now - try again in a minute" };
  }
  if (idUsed(jti)) return { ok: false, status: 409, error: "That door pass was made before - try again" };

  const doorKeyRef = doorKeyRefOf(hexToBytes(doorKey));
  let message: string;
  try {
    message = doorKeyRegistrationMessage(eventId, jti, doorKeyRef);
  } catch {
    return { ok: false, status: 400, error: "This event's id cannot carry a door pass" };
  }
  const signer = recoverPersonalSigner(message, sig);
  if (!signer || signer.toLowerCase() !== keys.feedSigner.toLowerCase()) {
    return {
      ok: false,
      status: 409,
      error: "This door pass wasn't signed with your account's current keys - reload the page and try again",
    };
  }
  return { ok: true, jti, doorKey, doorKeyRef, gen: keys.kind === "ring" ? keys.gen : 0 };
}
