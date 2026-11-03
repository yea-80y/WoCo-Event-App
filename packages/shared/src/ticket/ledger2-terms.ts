/**
 * What an organiser's ORGANISER KEY signs to change a ledger2 event, and what anyone
 * submitting it (in practice WoCo's relay) checks it against. WoCoTicketLedger version 2,
 * WoCo-Contracts master abf5fb5: capacity, sales cutoff, cancellation, seat moves, and
 * the bulk revoke the app shows as "Cancel" on a change that is still saving.
 *
 * The organiser's browser builds these from values it reads from the chain itself,
 * cross-checks the digest with the ledger's own digest view, signs, and hands over the
 * fields and signature. The relay rebuilds the same digest from its own chain reads and
 * recovers the signer before it simulates (a diagnostic: the chain decides). So this
 * file is the ONE encoder both sides use; `ledger2-terms.test.ts` pins its vectors and
 * the contracts repo pins the same vectors against the ledger's digest views.
 *
 * Every field the ledger reads from storage at submission (`nonce`/`termsNonce`, a seat
 * move's `holder`, `nonce` and `seatNonce`) is an input here, never a constant: a
 * signature made at one value recovers to some other address once the value moves, which
 * is how the ledger kills a used or superseded signature (`NotOrganiserKey`).
 *
 * The domain and type strings are the CONTRACT'S, byte for byte. Change one and every
 * signature the app makes is refused on chain.
 */

import type { EIP712TypeField } from "../auth/eip712-digest.js";
import { eip712DigestHex } from "../auth/eip712-digest.js";
import { recoverTypedStatementSigner, signTypedStatement, type TypedStatement } from "../crypto/digest-signature.js";

export const LEDGER2_DOMAIN_NAME = "WoCoTicketLedger";
export const LEDGER2_DOMAIN_VERSION = "2";

/** `WoCoTicketLedger.NO_SEAT` (type(uint64).max): no seat, and the move out of one. */
export const LEDGER2_NO_SEAT = (1n << 64n) - 1n;

/** `WoCoTicketLedger.MAX_TERMS_SIGNATURE_TTL`: the longest window a signature may name. */
export const LEDGER2_MAX_SIGNATURE_WINDOW_SECS = 48 * 60 * 60;

/** `WoCoTicketLedger.MAX_SALES_EXTENSION`: how far ahead of now a cutoff may move, per move. */
export const LEDGER2_MAX_SALES_EXTENSION_SECS = 730 * 24 * 60 * 60;

/**
 * The window the app signs: `issuedAt` 15 minutes behind the CHAIN's clock (a lagging
 * chain clock only delays a signature, and every minute backdated comes off its usable
 * span), `deadline` an hour ahead of it. Chain time, never the device's: the ledger
 * checks `block.timestamp`, and Arbitrum's can sit hours off the wall clock.
 */
export const LEDGER2_SIG_BACKDATE_SECS = 15 * 60;
export const LEDGER2_SIG_LIFETIME_SECS = 60 * 60;

/** What the relay accepts, measured from the chain clock it reads itself. */
export const LEDGER2_RELAY_MIN_LEFT_SECS = 5 * 60;
export const LEDGER2_RELAY_MAX_LEFT_SECS = 2 * 60 * 60;

export { MULTICALL3_ADDRESS } from "../chain/multicall.js";
/**
 * keccak256 of its runtime code, read 2026-11-02 from Arbitrum One, Ethereum and
 * Optimism (identical on all three). The relay refuses to batch through an address
 * whose code is anything else.
 */
export const MULTICALL3_CODE_HASH = "0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891";

const TERMS_TAIL: readonly EIP712TypeField[] = [
  { name: "nonce", type: "uint256" },
  { name: "issuedAt", type: "uint256" },
  { name: "deadline", type: "uint256" },
];

const SEAT_FIELDS: readonly EIP712TypeField[] = [
  { name: "eventId", type: "bytes32" },
  { name: "slot", type: "uint256" },
  { name: "toSeat", type: "uint256" },
  { name: "holder", type: "address" },
  { name: "nonce", type: "uint256" },
  { name: "termsNonce", type: "uint256" },
  { name: "seatNonce", type: "uint256" },
  { name: "issuedAt", type: "uint256" },
  { name: "deadline", type: "uint256" },
];

/** The six organiser-signed types, field for field as the ledger's typehash strings. */
export const LEDGER2_TYPES = {
  SetSupply: [{ name: "eventId", type: "bytes32" }, { name: "supply", type: "uint64" }, ...TERMS_TAIL],
  ExtendSalesEnd: [{ name: "eventId", type: "bytes32" }, { name: "eventEndTs", type: "uint64" }, ...TERMS_TAIL],
  CancelEvent: [{ name: "eventId", type: "bytes32" }, ...TERMS_TAIL],
  RevokeSignatures: [{ name: "eventId", type: "bytes32" }, ...TERMS_TAIL],
  Reseat: SEAT_FIELDS,
  ReseatBearer: SEAT_FIELDS,
} as const satisfies Record<string, readonly EIP712TypeField[]>;

export type Ledger2TermsKind = "setSupply" | "extendSalesEnd" | "cancel" | "revoke";
export type Ledger2SeatKind = "reseatBearer" | "reseat";
export type Ledger2Kind = Ledger2TermsKind | Ledger2SeatKind;

interface Window {
  issuedAt: number;
  deadline: number;
}

/** One signed change, with every value its digest commits to. */
export type Ledger2Action =
  | ({ kind: "setSupply"; eventId: string; supply: number; nonce: bigint } & Window)
  | ({ kind: "extendSalesEnd"; eventId: string; eventEndTs: number; nonce: bigint } & Window)
  | ({ kind: "cancel" | "revoke"; eventId: string; nonce: bigint } & Window)
  | ({
      kind: Ledger2SeatKind;
      eventId: string;
      slot: number;
      /** A seat index, or LEDGER2_NO_SEAT. */
      toSeat: bigint;
      holder: string;
      nonce: bigint;
      termsNonce: bigint;
      seatNonce: bigint;
    } & Window);

export interface Ledger2Target {
  chainId: number;
  /** The ledger's address: the domain's verifyingContract. */
  address: string;
}

const PRIMARY: Record<Ledger2Kind, keyof typeof LEDGER2_TYPES> = {
  setSupply: "SetSupply",
  extendSalesEnd: "ExtendSalesEnd",
  cancel: "CancelEvent",
  revoke: "RevokeSignatures",
  reseat: "Reseat",
  reseatBearer: "ReseatBearer",
};

export function isLedger2SeatKind(kind: Ledger2Kind): kind is Ledger2SeatKind {
  return kind === "reseat" || kind === "reseatBearer";
}

/** The typed statement for `action` on the ledger at `target`. */
export function ledger2Statement(target: Ledger2Target, action: Ledger2Action): TypedStatement {
  const primaryType = PRIMARY[action.kind];
  const { kind: _kind, ...message } = action;
  return {
    domain: {
      name: LEDGER2_DOMAIN_NAME,
      version: LEDGER2_DOMAIN_VERSION,
      chainId: target.chainId,
      verifyingContract: target.address,
    },
    primaryType,
    fields: LEDGER2_TYPES[primaryType],
    message,
  };
}

/** The 0x-prefixed digest the ledger's matching `*Digest` view returns for `action`. */
export function ledger2Digest(target: Ledger2Target, action: Ledger2Action): string {
  const s = ledger2Statement(target, action);
  return eip712DigestHex(s.domain, s.primaryType, s.fields, s.message);
}

/** Sign `action` with the organiser key (raw secp256k1 over the EIP-712 digest). */
export function signLedger2Action(target: Ledger2Target, action: Ledger2Action, privateKey: Uint8Array): string {
  return signTypedStatement(ledger2Statement(target, action), privateKey);
}

/** The lowercase address that signed `action`, or null for a non-canonical signature. */
export function recoverLedger2Signer(target: Ledger2Target, action: Ledger2Action, signature: unknown): string | null {
  try {
    return recoverTypedStatementSigner(ledger2Statement(target, action), signature);
  } catch {
    return null;
  }
}

/** The window to sign at chain time `chainNowSecs`. */
export function ledger2SignatureWindow(chainNowSecs: number): Window {
  return {
    issuedAt: chainNowSecs - LEDGER2_SIG_BACKDATE_SECS,
    deadline: chainNowSecs + LEDGER2_SIG_LIFETIME_SECS,
  };
}

export type Ledger2WindowRefusal =
  | "window_invalid"
  | "signature_not_yet_valid"
  | "signature_expiring"
  | "deadline_too_far";

/**
 * Why the relay will not take a signature with this window at chain time `chainNowSecs`,
 * or null. Mirrors the ledger's own checks (`_checkWindow`: expired once chain time is
 * PAST the deadline, not yet valid while `issuedAt` is ahead of it, at most 48 h long),
 * then narrows: at least 5 minutes left, so it cannot lapse in the queue, and at most
 * 2 hours, so a signature handed to us is never a long-standing option.
 */
export function ledger2WindowRefusal(issuedAt: unknown, deadline: unknown, chainNowSecs: number): Ledger2WindowRefusal | null {
  if (!isUintSeconds(issuedAt) || !isUintSeconds(deadline) || !isUintSeconds(chainNowSecs)) return "window_invalid";
  if (deadline < issuedAt || deadline - issuedAt > LEDGER2_MAX_SIGNATURE_WINDOW_SECS) return "deadline_too_far";
  if (issuedAt > chainNowSecs) return "signature_not_yet_valid";
  if (deadline - chainNowSecs < LEDGER2_RELAY_MIN_LEFT_SECS) return "signature_expiring";
  if (deadline - chainNowSecs > LEDGER2_RELAY_MAX_LEFT_SECS) return "deadline_too_far";
  return null;
}

function isUintSeconds(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

// ── Seat sequences ───────────────────────────────────────────────────────────

/** A slot as the ledger holds it before a sequence of moves. */
export interface SeatSlotState {
  /** Lowercase; the `holder` a move on it commits to. */
  owner: string;
  transferNonce: bigint;
  /** Its seat now, or LEDGER2_NO_SEAT. */
  seat: bigint;
}

export interface SeatMoveNonces {
  holder: string;
  nonce: bigint;
  termsNonce: bigint;
  seatNonce: bigint;
}

/**
 * The digest inputs of each move in `moves`, applied in order to the state the chain
 * holds now: a later move on a slot commits to the transfer nonce the earlier one left,
 * and a move into a seat an earlier move freed commits to the bumped seat nonce
 * (`_reseat`: frees the old seat, bumping its `seatNonces`, then bumps the slot's
 * `transferNonces`). That is how a dependent rearrangement - a swap is `a` to NO_SEAT,
 * `b` into `a`'s seat, `a` into `b`'s - is signed all at once, and how the relay checks
 * it. Seat moves never touch `termsNonces`. `seatNonces[NO_SEAT]` is always 0: that
 * seat is never freed.
 *
 * Null when a move names a slot or a target seat `slots`/`seatNonces` do not cover, or
 * a move that cannot land: into its own seat, or into a seat a slot of THIS sequence
 * holds by then. A seat held by a ticket outside the sequence is the chain's to refuse.
 */
export function planSeatMoveNonces(
  termsNonce: bigint,
  slots: ReadonlyMap<number, SeatSlotState>,
  seatNonces: ReadonlyMap<bigint, bigint>,
  moves: ReadonlyArray<{ slot: number; toSeat: bigint }>,
): SeatMoveNonces[] | null {
  const live = new Map<number, SeatSlotState>();
  for (const [k, v] of slots) live.set(k, { ...v });
  const nonces = new Map(seatNonces);
  const taken = new Set<bigint>();
  for (const s of live.values()) if (s.seat !== LEDGER2_NO_SEAT) taken.add(s.seat);

  const out: SeatMoveNonces[] = [];
  for (const m of moves) {
    const s = live.get(m.slot);
    if (!s) return null;
    if (m.toSeat === s.seat) return null;
    let seatNonce = 0n;
    if (m.toSeat !== LEDGER2_NO_SEAT) {
      const n = nonces.get(m.toSeat);
      if (n === undefined || taken.has(m.toSeat)) return null;
      seatNonce = n;
    }
    out.push({ holder: s.owner, nonce: s.transferNonce, termsNonce, seatNonce });
    if (s.seat !== LEDGER2_NO_SEAT) {
      taken.delete(s.seat);
      nonces.set(s.seat, (nonces.get(s.seat) ?? 0n) + 1n);
    }
    if (m.toSeat !== LEDGER2_NO_SEAT) taken.add(m.toSeat);
    s.seat = m.toSeat;
    s.transferNonce += 1n;
  }
  return out;
}

// ── The relay's wire format ──────────────────────────────────────────────────

/**
 * One change as the organiser's browser sends it. Names the SERIES, never an on-chain id:
 * which ledger event a series is lives in the server's registry, and a body-supplied id
 * would aim a signature at an event the ownership check never saw.
 */
export type Ledger2RelayItem =
  | { kind: "setSupply"; seriesId: string; supply: number; issuedAt: number; deadline: number; sig: string }
  | { kind: "extendSalesEnd"; seriesId: string; eventEndTs: number; issuedAt: number; deadline: number; sig: string }
  | { kind: "cancel" | "revoke"; seriesId: string; issuedAt: number; deadline: number; sig: string }
  | {
      kind: Ledger2SeatKind;
      seriesId: string;
      slot: number;
      /** A seat index, or "none" to empty the slot's seat. */
      toSeat: number | "none";
      issuedAt: number;
      deadline: number;
      sig: string;
      /** `reseat` only: the holder's signature over the same digest. */
      holderSig?: string;
    };

/**
 * A revoke signed at the same terms nonce as the batch, submitted ONLY if the batch
 * reverts on chain: a reverted batch publishes its signatures, and the still-valid part
 * of a dependent seat rearrangement could otherwise be landed part-way by anyone
 * (audit 1156 L-1). Held in the request's memory, never stored.
 */
export interface Ledger2RelayAbort {
  seriesId: string;
  issuedAt: number;
  deadline: number;
  sig: string;
}

export interface Ledger2RelayRequest {
  items: Ledger2RelayItem[];
  aborts?: Ledger2RelayAbort[];
}

/** Per item, whether it landed: read from the receipt's ledger logs, never assumed. */
export interface Ledger2RelayResult {
  status: "landed" | "unconfirmed" | "reverted_on_chain";
  txHash: string;
  /** Same order as the request's items. Absent while unconfirmed. */
  landed?: boolean[];
  /** Whether the abort revokes were submitted, after a revert. */
  aborted?: boolean;
}

export function seatFromWire(toSeat: number | "none"): bigint {
  return toSeat === "none" ? LEDGER2_NO_SEAT : BigInt(toSeat);
}
