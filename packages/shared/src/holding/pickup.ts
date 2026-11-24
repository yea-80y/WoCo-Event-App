/**
 * Collecting a receipt from the server's copy, and erasing that copy.
 * Spec: woco-ops/spec-receipt-note-20261123.md section 5.2.
 *
 * A guest's ticket email links to `{APP}/#/keep?k=<secret>&b=<box root>`. Everything
 * after `#` stays in the browser: it is never sent in a request. `k` is the order's
 * secret and opens the box; `b` only says where the box is on Swarm, so the app can
 * fetch it with no call to WoCo's server. Erasing the server's copy is authorised by
 * a signature from the order's pickup signer (`derive.ts`), never by a session, so the
 * erase links no account to the ticket.
 *
 * FROZEN: the link's shape (emails already sent keep working) and the erase statement.
 * The erase is EIP-712 rather than plain EIP-191 so it shares the canonical-signature
 * checks (low-s, v 27/28) and can never be read as a door QR (EIP-191).
 */

import { eip712DigestHex, type EIP712TypeField } from "../auth/eip712-digest.js";
import { recoverTypedStatementSigner, signTypedStatement, type TypedStatement } from "../crypto/digest-signature.js";
import { HOLDING_SECRET_BYTES } from "./derive.js";

export const HOLDING_KEEP_ROUTE = "#/keep";

const PICKUP_ID_RE = /^[0-9a-f]{64}$/;
const ROOT_RE = /^[0-9a-f]{64}$/;
const B64URL_RE = /^[A-Za-z0-9_-]{43}$/;

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The fragment a ticket email links to. `boxRoot`: the box's /bytes root, 64 lowercase hex. */
export function holdingKeepFragment(r: Uint8Array, boxRoot?: string): string {
  if (!(r instanceof Uint8Array) || r.length !== HOLDING_SECRET_BYTES) throw new Error("holding secret must be 32 bytes");
  if (boxRoot !== undefined && !ROOT_RE.test(boxRoot)) throw new Error("box root must be 64 lowercase hex");
  return `${HOLDING_KEEP_ROUTE}?k=${toBase64Url(r)}${boxRoot ? `&b=${boxRoot}` : ""}`;
}

/** The secret and optional box root from a Keep fragment, or null for anything malformed. */
export function parseHoldingKeepFragment(fragment: string): { r: Uint8Array; boxRoot?: string } | null {
  if (typeof fragment !== "string" || !fragment.startsWith(`${HOLDING_KEEP_ROUTE}?`)) return null;
  const params = new URLSearchParams(fragment.slice(HOLDING_KEEP_ROUTE.length + 1));
  const k = params.get("k");
  const b = params.get("b");
  if (k === null || !B64URL_RE.test(k)) return null;
  if (b !== null && !ROOT_RE.test(b)) return null;
  for (const key of params.keys()) if (key !== "k" && key !== "b") return null;
  if (params.getAll("k").length !== 1 || params.getAll("b").length > 1) return null;
  const r = fromBase64Url(k);
  if (r.length !== HOLDING_SECRET_BYTES || toBase64Url(r) !== k) return null;
  return b === null ? { r } : { r, boxRoot: b };
}

// ---------------------------------------------------------------------------
// Erasing the server's copy
// ---------------------------------------------------------------------------

export const HOLDING_PICKUP_DOMAIN_NAME = "WoCo Holding Pickup";
export const HOLDING_PICKUP_DOMAIN_VERSION = "1";

/** How far an erase's `issuedAt` may sit from the server's clock. */
export const HOLDING_ERASE_WINDOW_SECS = 5 * 60;

export const ERASE_PICKUP_FIELDS: readonly EIP712TypeField[] = [
  { name: "pickupId", type: "bytes32" },
  { name: "issuedAt", type: "uint64" },
];

export function erasePickupStatement(pickupId: string, issuedAt: number): TypedStatement {
  if (!PICKUP_ID_RE.test(pickupId)) throw new Error("pickup id must be 64 lowercase hex");
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error("bad issuedAt");
  return {
    domain: { name: HOLDING_PICKUP_DOMAIN_NAME, version: HOLDING_PICKUP_DOMAIN_VERSION },
    primaryType: "ErasePickup",
    fields: ERASE_PICKUP_FIELDS,
    message: { pickupId: `0x${pickupId}`, issuedAt },
  };
}

export function erasePickupDigest(pickupId: string, issuedAt: number): string {
  const s = erasePickupStatement(pickupId, issuedAt);
  return eip712DigestHex(s.domain, s.primaryType, s.fields, s.message);
}

export function signErasePickup(pickupId: string, issuedAt: number, pickupSignerPrivateKey: Uint8Array): string {
  return signTypedStatement(erasePickupStatement(pickupId, issuedAt), pickupSignerPrivateKey);
}

/** Whether an erase request is signed by the order's pickup signer, inside the window. */
export function checkErasePickup(args: {
  pickupId: string;
  issuedAt: number;
  signature: unknown;
  expectedSigner: string;
  nowSecs: number;
}): boolean {
  try {
    // A broken clock (NaN, undefined) would pass the window check below.
    if (!Number.isFinite(args.nowSecs)) return false;
    if (Math.abs(args.nowSecs - args.issuedAt) > HOLDING_ERASE_WINDOW_SECS) return false;
    const signer = recoverTypedStatementSigner(erasePickupStatement(args.pickupId, args.issuedAt), args.signature);
    return signer !== null && signer === args.expectedSigner.toLowerCase();
  } catch {
    return false;
  }
}
