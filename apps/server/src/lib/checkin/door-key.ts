/**
 * The door entries key a new door pass registers (live door attendee list), and the
 * proof that lets it register one.
 *
 * The server seals every later sale's email and card name to this key, so the request
 * must come from whoever holds the account's keys - not merely a login session, and not
 * the content-feed signer either: that one is cached on the device beside the session
 * with no expiry, so it proves no unlock. The order key does. So issuing a pass is two
 * requests:
 *
 *   1. challenge: 32 random bytes sealed to the event's CURRENT order key
 *      (`woco/door-key-proof/v1`, AAD = event, account, challenge id), kept here in memory
 *      for 120 s, one per (account, event) - a new one replaces the last.
 *   2. pass: HMAC-SHA256 under that nonce over the transcript (`doorKeyProofTranscript`),
 *      checked over the server's OWN event id and account. The nonce never travels back.
 *
 * A challenge is used once, whatever follows, and a restart forgets them all: the page
 * asks for a new one ("challenge-expired") and tries once more. No proof, no pass.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { hexToBytes } from "@noble/hashes/utils.js";
import { fetchOrderKey, type DoorMode, type DoorPassChallenge } from "@woco/shared";
import { DOOR_KEY_CHALLENGE_ID_RE, DOOR_PASS_ID_RE, doorKeyProof, doorKeyRefOf } from "@woco/shared/checkin/door-keys";
import { isValidXWingPublicKey, XWING_PUBLIC_KEY_BYTES } from "@woco/shared/crypto/xwing";
import { BEE_URL } from "../../config/swarm.js";
import type { EventKeys } from "../keyring/event-keys.js";

export const DOOR_KEY_CHALLENGE_TTL_MS = 120_000;
/** Memory bound: past this, expired challenges go first, then the oldest. */
const MAX_CHALLENGES = 10_000;

const DOOR_KEY_RE = new RegExp(`^[0-9a-f]{${XWING_PUBLIC_KEY_BYTES * 2}}$`);
const PROOF_RE = /^[0-9a-f]{64}$/;
const OUTDATED_PAGE = "This page needs updating to make door passes - reload it and try again";
export const KEYS_CHANGED = "Your account's keys changed - reload the page and make the door pass again";
const LEGACY =
  "This event was created before door passes were tied to your account's keys - create the event again to use the door scanner";
const UNAVAILABLE = "Couldn't check your account's keys right now - try again in a minute";

type Refusal = { ok: false; status: 400 | 409 | 503; error: string; reason?: "challenge-expired" | "keys-changed" };

interface Challenge {
  nonce: Buffer;
  parent: string;
  eventId: string;
  orderKeyRef: string;
  exp: number;
}

const challenges = new Map<string, Challenge>();
const byPair = new Map<string, string>();
const pairOf = (parent: string, eventId: string) => `${parent}\0${eventId}`;

function drop(challengeId: string): void {
  const c = challenges.get(challengeId);
  if (!c) return;
  challenges.delete(challengeId);
  if (byPair.get(pairOf(c.parent, c.eventId)) === challengeId) byPair.delete(pairOf(c.parent, c.eventId));
  c.nonce.fill(0);
}

function prune(now: number): void {
  for (const [id, c] of challenges) if (c.exp <= now) drop(id);
  while (challenges.size >= MAX_CHALLENGES) drop(challenges.keys().next().value!);
}

/** The order key by its ref. Content-addressed and verified against the ref, so a cached
 *  copy is as good as a fresh one. */
let fetchKey = (ref: string) => fetchOrderKey(ref, BEE_URL);
const orderKeys = new Map<string, Uint8Array>();
async function orderKey(ref: string): Promise<Uint8Array> {
  const cached = orderKeys.get(ref);
  if (cached) return cached;
  const pk = await fetchKey(ref);
  if (orderKeys.size >= 1000) orderKeys.delete(orderKeys.keys().next().value!);
  orderKeys.set(ref, pk);
  return pk;
}

/** The order key buyers seal to, or why there is none to prove against. */
function currentOrderKeyRef(keys: EventKeys): { ref: string } | Refusal {
  if (keys.kind === "unavailable") return { ok: false, status: 503, error: UNAVAILABLE };
  if (keys.kind === "legacy" || !keys.orderKeyRef) return { ok: false, status: 409, error: LEGACY };
  return { ref: keys.orderKeyRef };
}

/** Step 1: a nonce sealed to the event's current order key, for this account. */
export async function createDoorPassChallenge(
  eventId: string,
  parent: string,
  keys: EventKeys,
  now: number = Date.now(),
): Promise<{ ok: true; data: DoorPassChallenge } | Refusal> {
  const current = currentOrderKeyRef(keys);
  if (!("ref" in current)) return current;
  let pk: Uint8Array;
  try {
    pk = await orderKey(current.ref);
  } catch (err) {
    console.error("[checkin] order key unavailable for a door-pass challenge:", err);
    return { ok: false, status: 503, error: UNAVAILABLE };
  }
  const account = parent.toLowerCase();
  const challengeId = randomBytes(16).toString("hex");
  const nonce = randomBytes(32);
  const { sealBox, doorKeyProofSealContext } = await import("@woco/shared/crypto/sealed-box");
  const box = await sealBox(pk, new Uint8Array(nonce), doorKeyProofSealContext(eventId, account, challengeId));

  prune(now);
  const prev = byPair.get(pairOf(account, eventId));
  if (prev) drop(prev);
  const exp = now + DOOR_KEY_CHALLENGE_TTL_MS;
  challenges.set(challengeId, { nonce, parent: account, eventId, orderKeyRef: current.ref, exp });
  byPair.set(pairOf(account, eventId), challengeId);
  return { ok: true, data: { challengeId, box, exp: Math.floor(exp / 1000) } };
}

export type DoorPassGrant = { ok: true; jti: string; doorKey: string; doorKeyRef: string; mode: DoorMode; gen: number };

/**
 * Step 2, in this order: shape; the event's keys; a pass id never used; the challenge
 * (this account, this event, unexpired) - consumed here, whatever follows; the order key
 * unchanged since; the proof over the server's own event id and account.
 *
 * @param idUsed whether this event has ever had a pass with this id: a captured proof
 *   must not bring back an old pass, whose link may be out there.
 */
export function redeemDoorPassChallenge(
  eventId: string,
  parent: string,
  body: { mode?: unknown; jti?: unknown; doorKey?: unknown; challengeId?: unknown; proof?: unknown } | undefined,
  keys: EventKeys,
  idUsed: (jti: string) => boolean,
  now: number = Date.now(),
): DoorPassGrant | Refusal {
  const { mode, jti, doorKey, challengeId, proof } = body ?? {};
  if (
    typeof jti !== "string" || !DOOR_PASS_ID_RE.test(jti) ||
    typeof doorKey !== "string" || !DOOR_KEY_RE.test(doorKey) || !isValidXWingPublicKey(hexToBytes(doorKey)) ||
    (mode !== "single" && mode !== "several") ||
    typeof challengeId !== "string" || !DOOR_KEY_CHALLENGE_ID_RE.test(challengeId) ||
    typeof proof !== "string" || !PROOF_RE.test(proof)
  ) {
    return { ok: false, status: 400, error: OUTDATED_PAGE };
  }
  const current = currentOrderKeyRef(keys);
  if (!("ref" in current)) return current;
  if (idUsed(jti)) return { ok: false, status: 409, error: "That door pass was made before - try again" };

  const account = parent.toLowerCase();
  const c = challenges.get(challengeId);
  if (!c || c.exp <= now || c.parent !== account || c.eventId !== eventId) {
    return { ok: false, status: 409, error: "That took too long - try again", reason: "challenge-expired" };
  }
  const nonce = Buffer.from(c.nonce);
  drop(challengeId);
  try {
    if (c.orderKeyRef !== current.ref) return { ok: false, status: 409, error: KEYS_CHANGED, reason: "keys-changed" };
    const doorKeyRef = doorKeyRefOf(hexToBytes(doorKey));
    const expected = Buffer.from(doorKeyProof(new Uint8Array(nonce), { eventId, parent: account, challengeId, jti, mode, doorKeyRef }), "hex");
    if (!timingSafeEqual(expected, Buffer.from(proof, "hex"))) {
      return { ok: false, status: 409, error: "Your account's keys could not be confirmed - reload the page and try again" };
    }
    return { ok: true, jti, doorKey, doorKeyRef, mode, gen: keys.kind === "ring" ? keys.gen : 0 };
  } catch {
    // An event id the transcript cannot carry: it could not have had a challenge either.
    return { ok: false, status: 400, error: OUTDATED_PAGE };
  } finally {
    nonce.fill(0);
  }
}

export function _setDoorKeyDepsForTests(deps: { fetchOrderKey?: (ref: string) => Promise<Uint8Array>; clear?: boolean }): void {
  if (deps.fetchOrderKey) {
    fetchKey = deps.fetchOrderKey;
    orderKeys.clear();
  }
  if (deps.clear) for (const id of [...challenges.keys()]) drop(id);
}
