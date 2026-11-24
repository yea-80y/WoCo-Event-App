/**
 * Everything a ticket RECEIPT hangs off: one random 32-byte secret `r` per order.
 * Spec: woco-ops/spec-receipt-note-20261123.md section 2.
 *
 * A signed-in buyer's browser makes `r` at checkout and seals it to the account, so the
 * server never sees it. For a guest, fulfilment makes it after payment, puts it in the
 * ticket email's link and drops it (option A). Either way, these derivations turn it
 * into the public values the receipt commits to, and the keys only the holder of `r`
 * has. The server is sent public values only.
 *
 * FROZEN: every label, the empty salts, the 48-byte secp derivation (`secp-hkdf.ts`),
 * the decimal ticket index and nk's zeroed top byte. Receipts are signed over values
 * derived here, so a change orphans every receipt already issued.
 *
 * Per ticket (index i = the i-th slot of the order, ascending):
 *   holder_i  - the address a future note hands the ticket to. Never signs anything
 *               until it actually owns the slot.
 *   answer_i  - signs every presentation of the receipt, so the holder key never does.
 * Per order:
 *   nk        - the count-once secret: one per ORDER, so a buyer of four tickets is
 *               counted or paid once per order, never four times.
 *   pickup id / signer / KEM - three DISTINCT labels for where the server's copy is
 *               found, who may erase it, and what it is sealed to.
 */

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { deriveSecpFromSeed } from "../crypto/secp-hkdf.js";
import { xwing, type XWingKeypair } from "../crypto/xwing.js";
import type { Hex0x } from "../types.js";

export const HOLDING_SECRET_BYTES = 32;

/** The most tickets one order's derivations cover: the ledger's batch cap. Checkout caps orders at 10. */
export const HOLDING_MAX_TICKETS = 100;

export const HOLDING_HOLDER_KEY_INFO = "woco/holding/v1/holder-key";
export const HOLDING_ANSWER_KEY_INFO = "woco/holding/v1/answer-key";
export const HOLDING_NK_INFO = "woco/holding/v1/nk";
export const HOLDING_NK_COMMIT_TAG = "woco/holding/v1/nk-commit";
export const HOLDING_PICKUP_ID_INFO = "woco/holding/v1/pickup-id";
export const HOLDING_PICKUP_SIGNER_INFO = "woco/holding/v1/pickup-signer";
export const HOLDING_PICKUP_KEM_INFO = "woco/holding/v1/pickup-kem";

const EMPTY = new Uint8Array(0);

/** A fresh order secret. The caller keeps it only where section 5 of the spec says. */
export function newHoldingSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(HOLDING_SECRET_BYTES));
}

function secretHex(r: Uint8Array): string {
  if (!(r instanceof Uint8Array) || r.length !== HOLDING_SECRET_BYTES) {
    throw new Error(`holding secret must be ${HOLDING_SECRET_BYTES} bytes`);
  }
  return bytesToHex(r);
}

function ticketIndex(i: number): string {
  if (!Number.isInteger(i) || i < 0 || i >= HOLDING_MAX_TICKETS) {
    throw new Error(`ticket index must be an integer 0..${HOLDING_MAX_TICKETS - 1}`);
  }
  return String(i);
}

function hkdf32(r: Uint8Array, info: string): Uint8Array {
  secretHex(r);
  return hkdf(sha256, r, EMPTY, utf8ToBytes(info), 32);
}

/** Ticket i's ownership key. Its address is what a note names as `to`. */
export function holdingHolderKey(r: Uint8Array, i: number): { privateKey: Uint8Array; address: string } {
  return deriveSecpFromSeed(secretHex(r), `${HOLDING_HOLDER_KEY_INFO}/${ticketIndex(i)}`, "holding secret");
}

/** Ticket i's answer key: signs presentations (`receipt.ts`). */
export function holdingAnswerKey(r: Uint8Array, i: number): { privateKey: Uint8Array; address: string } {
  return deriveSecpFromSeed(secretHex(r), `${HOLDING_ANSWER_KEY_INFO}/${ticketIndex(i)}`, "holding secret");
}

/** The order's count-once secret, top byte zeroed so it fits a BN254 field element (read big-endian). */
export function holdingNk(r: Uint8Array): Uint8Array {
  const nk = hkdf32(r, HOLDING_NK_INFO);
  nk[0] = 0;
  return nk;
}

/** keccak256(abi.encode(keccak256("woco/holding/v1/nk-commit"), bytes32(nk))). */
export function holdingNkCommit(nk: Uint8Array): Hex0x {
  if (!(nk instanceof Uint8Array) || nk.length !== 32 || nk[0] !== 0) {
    throw new Error("nk must be 32 bytes with a zero top byte");
  }
  const tag = keccak_256(utf8ToBytes(HOLDING_NK_COMMIT_TAG));
  return `0x${bytesToHex(keccak_256(concatBytes(tag, nk)))}`;
}

/** Where the server's copy is looked up: 64 lowercase hex, no 0x. Knowing it opens nothing. */
export function holdingPickupId(r: Uint8Array): string {
  return bytesToHex(hkdf32(r, HOLDING_PICKUP_ID_INFO));
}

/** The key whose signature erases the server's copy (`pickup.ts`). */
export function holdingPickupSigner(r: Uint8Array): { privateKey: Uint8Array; address: string } {
  return deriveSecpFromSeed(secretHex(r), HOLDING_PICKUP_SIGNER_INFO, "holding secret");
}

/** What the receipt box is sealed to (X-Wing, post-quantum). */
export function holdingPickupKem(r: Uint8Array): XWingKeypair {
  const { secretKey, publicKey } = xwing.keygen(hkdf32(r, HOLDING_PICKUP_KEM_INFO));
  return { secretKey, publicKey };
}

/** The public values checkout (or fulfilment, for a guest) hands the server for an order of `n` tickets. */
export interface HoldingPublicValues {
  holders: string[];
  answerKeys: string[];
  nkCommit: Hex0x;
  pickupId: string;
  pickupSigner: string;
  pickupPub: Uint8Array;
}

export function holdingPublicValues(r: Uint8Array, n: number): HoldingPublicValues {
  if (!Number.isInteger(n) || n < 1 || n > HOLDING_MAX_TICKETS) {
    throw new Error(`an order holds 1..${HOLDING_MAX_TICKETS} tickets`);
  }
  const holders: string[] = [];
  const answerKeys: string[] = [];
  for (let i = 0; i < n; i++) {
    holders.push(holdingHolderKey(r, i).address);
    answerKeys.push(holdingAnswerKey(r, i).address);
  }
  return {
    holders,
    answerKeys,
    nkCommit: holdingNkCommit(holdingNk(r)),
    pickupId: holdingPickupId(r),
    pickupSigner: holdingPickupSigner(r).address,
    pickupPub: holdingPickupKem(r).publicKey,
  };
}
