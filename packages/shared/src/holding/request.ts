/**
 * What a SIGNED-IN buyer's browser sends with create-checkout so the sale's receipts
 * can be signed (spec woco-ops/spec-receipt-note-20261123.md section 5.1): the order's
 * public values (`derive.ts`) and its secret sealed to the buyer's own account key.
 * The secret itself never leaves the browser in the clear. A guest sends nothing: the
 * server makes a guest's secret at fulfilment (option A, section 5.2).
 *
 * VERSIONED, not frozen. The server reads it with `parseHoldingRequest` and ignores
 * anything that does not parse: a bad request costs that sale its receipt, never the
 * sale.
 */

import { isSealedBoxV2, type SealedBoxV2 } from "../crypto/sealed-box-shape.js";
import { XWING_PUBLIC_KEY_BYTES } from "../crypto/xwing.js";
import { HOLDING_MAX_TICKETS } from "./derive.js";

/** Months after the event's on-chain end that an unclaimed receipt's server copy is kept (owner, 2026-11-23). */
export const HOLDING_RETENTION_MONTHS = 12;

export interface HoldingRequestV1 {
  v: 1;
  holders: string[];
  answerKeys: string[];
  nkCommit: string;
  pickupId: string;
  pickupSigner: string;
  /** The order's pickup X-Wing public key, hex. */
  pickupPub: string;
  /** The order secret sealed to the buyer's account order key (`holdingSecretSealContext`). */
  sealedR: SealedBoxV2;
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const BYTES32_RE = /^0x[0-9a-f]{64}$/;
const PICKUP_ID_RE = /^[0-9a-f]{64}$/;
const PUB_RE = new RegExp(`^[0-9a-f]{${XWING_PUBLIC_KEY_BYTES * 2}}$`);
/** The ciphertext of a sealed 32-byte order secret, hex: 32 bytes plus the 16-byte tag. */
export const SEALED_SECRET_CT_HEX = 96;

/**
 * The request for an order of exactly `quantity` tickets, or null. Every address
 * distinct: one key may hold one ticket and answer for one ticket, never two roles.
 */
export function parseHoldingRequest(x: unknown, quantity: number): HoldingRequestV1 | null {
  const q = x as Partial<HoldingRequestV1> | null;
  if (!q || typeof q !== "object" || Array.isArray(q) || q.v !== 1) return null;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > HOLDING_MAX_TICKETS) return null;
  if (!Array.isArray(q.holders) || !Array.isArray(q.answerKeys)) return null;
  if (q.holders.length !== quantity || q.answerKeys.length !== quantity) return null;
  const addresses = [...q.holders, ...q.answerKeys, q.pickupSigner];
  if (!addresses.every((a) => typeof a === "string" && ADDRESS_RE.test(a))) return null;
  if (new Set(addresses).size !== addresses.length) return null;
  if (typeof q.nkCommit !== "string" || !BYTES32_RE.test(q.nkCommit)) return null;
  if (typeof q.pickupId !== "string" || !PICKUP_ID_RE.test(q.pickupId)) return null;
  if (typeof q.pickupPub !== "string" || !PUB_RE.test(q.pickupPub)) return null;
  // A sealed 32-byte secret is exactly 48 bytes of ciphertext (the secret and its tag).
  // Anything longer is not one, and every request is written to disk and held in memory.
  if (!isSealedBoxV2(q.sealedR) || q.sealedR.ct.length !== SEALED_SECRET_CT_HEX) return null;
  return {
    v: 1,
    holders: [...q.holders] as string[],
    answerKeys: [...q.answerKeys] as string[],
    nkCommit: q.nkCommit,
    pickupId: q.pickupId,
    pickupSigner: q.pickupSigner as string,
    pickupPub: q.pickupPub,
    sealedR: q.sealedR,
  };
}
