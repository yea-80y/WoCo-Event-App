/**
 * Linking another device (#746 step 4): the mailbox two devices pass messages
 * through for one pairing.
 *
 * The devices share a code by QR or by typing it, and the server never sees it.
 * Every message is sealed under a key derived from that code, so the server holds
 * bytes it cannot read, cannot alter without detection, and forgets them after
 * PAIRING_TTL_MS. It is transport only: what a message is allowed to change is
 * decided by the signed grants it carries and by the server's grant list, never
 * by the mailbox.
 *
 * Three slots, written once each and in order: the device that started shows the
 * code and writes `offer`; the account's main device writes `answer`; `reply` is
 * used only when the starting device must sign something after the answer (making
 * it the main passkey).
 */

export const PAIRING_SLOTS = ["offer", "answer", "reply"] as const;
export type PairingSlot = (typeof PAIRING_SLOTS)[number];

/** The slot that must be filled before this one may be written. */
export const PAIRING_SLOT_AFTER: Readonly<Record<PairingSlot, PairingSlot | null>> = {
  offer: null,
  answer: "offer",
  reply: "answer",
};

/** From the offer: every slot of one pairing expires together. */
export const PAIRING_TTL_MS = 10 * 60_000;

/** A sealed message, base64url. The largest is a reply carrying the new main's
 *  grants for every other device (MAX_DEVICE_GRANTS + the old main). */
export const PAIRING_MAX_BOX_CHARS = 12_000;

/** The mailbox id: 32 bytes from the code, lowercase hex. Unguessable without it. */
export const PAIRING_ID_RE = /^[0-9a-f]{64}$/;

export const PAIRING_BOX_RE = /^[A-Za-z0-9_-]+$/;

export function isPairingSlot(v: unknown): v is PairingSlot {
  return typeof v === "string" && (PAIRING_SLOTS as readonly string[]).includes(v);
}
