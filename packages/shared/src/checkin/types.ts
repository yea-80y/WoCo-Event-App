import { parseTicketFragment, TICKET_PAGE_PATH } from "../ticket/link.js";
import type { Hex0x } from "../types.js";

// ---------------------------------------------------------------------------
// Door check-in — shared between server, dashboard, and the scanner PWA.
//
// Trust model:
// - The QR sig must recover to the on-chain slotOwner. The scanner verifies
//   this offline against `slotOwners` from the CheckinPack. A series with no
//   `onChainEventId` is rejected — there is no owner to recover against.
// - The roster is AES-GCM ciphertext end-to-end: the key travels only in the
//   door-pass URL fragment and is never sent to the server.
// - A ticket whose sale was refunded in full (#645) still verifies — the chain
//   has no per-slot void — so `voidSlots` is checked AFTER the signature: a
//   forgery still reads invalid, and only a genuine ticket can read refunded.
// - A ticket is admitted ONCE, across every scanner (#641). Check-in is a
//   capacity control, so a second admission is a defect, never a statistic. With
//   several scanners, admission is an atomic server claim (first scan anywhere
//   wins); a scanner that cannot reach the server refuses. Only a pass bound to
//   exactly one device may admit offline.
// ---------------------------------------------------------------------------

export const DOOR_PASS_VERSION = "v1" as const;

/** Decoded door-pass token (the HMAC tag binds all fields). */
export interface DoorPassPayload {
  v: typeof DOOR_PASS_VERSION;
  eventId: string;
  /** Rotation nonce — regenerating the pass changes this, revoking old passes. */
  jti: string;
  /** Unix seconds. */
  exp: number;
}

/**
 * How many scanners a door pass serves, chosen by the organiser when issuing it.
 * - "single": the pass binds to the first device that loads it and no other can
 *   use it, so that one device may admit offline from its own set.
 * - "several": every admission is claimed at the server first; no connection
 *   means no admission.
 * A pack or pass that names no mode is treated as "several" - the mode that
 * cannot admit twice.
 */
export type DoorMode = "single" | "several";

/** Header every scanner request carries: the device's stable random id. */
export const SCANNER_DEVICE_HEADER = "X-Scanner-Device";

/** One check-in — the nullifier unit. Identity is (seriesId, edition). */
export interface CheckinRecord {
  seriesId: string;
  edition: number;
  /** ISO timestamp of the check-in on the recording device. */
  at: string;
  /** Random per-device id — lets sync attribute duplicate offline scans. */
  deviceId: string;
  method: "scan" | "manual";
  /** Random id of the scan attempt that claimed it (#641): a device retrying the
   *  same attempt is told "admitted", never mistaken for a second admission. */
  claimId?: string;
}

/** Same ticket recorded by two devices. Since #641 this is a defect to
 *  investigate, not an expected outcome of offline scanning. */
export interface CheckinConflict {
  seriesId: string;
  edition: number;
  records: CheckinRecord[];
}

/** Per-series verification material inside the pack. */
export interface CheckinSeries {
  seriesId: string;
  name: string;
  totalSupply: number;
  /** Required for a series to be verifiable — enables offline ecrecover.
   *  Absent means the scanner rejects every ticket for this series. */
  onChainEventId?: Hex0x;
  /** Lowercase owner address per slot (index = edition - 1); zero-address
   *  slots are unclaimed. */
  slotOwners?: string[];
  /** Slots (edition - 1) whose sale was refunded in full or charged back
   *  (#645): the ticket is genuine but paid for no longer, so the door must not
   *  admit it. Absent from packs built before this shipped, which read as "none". */
  voidSlots?: number[];
}

/** Everything a scanner device needs to operate offline. */
export interface CheckinPack {
  v: 1;
  eventId: string;
  eventTitle: string;
  eventDate?: string;
  series: CheckinSeries[];
  /** AES-GCM roster ciphertext (base64) + IV (base64), decryptable only with
   *  the key from the door-pass fragment. Absent until the organiser pushes. */
  roster?: EncryptedRoster;
  /** Server's merged check-in set at pack time. */
  checkins: CheckinRecord[];
  /** The pass's door mode (#641). Absent reads as "several". */
  doorMode?: DoorMode;
  generatedAt: string;
}

export interface EncryptedRoster {
  iv: string;
  ciphertext: string;
  updatedAt: string;
}

/** Decrypted roster entry — one per issued ticket with order data. */
export interface RosterEntry {
  seriesId: string;
  seriesName: string;
  edition: number;
  name?: string;
  email?: string;
  /** Remaining decrypted order-form fields, verbatim. */
  fields?: Record<string, string>;
}

export interface CheckinSyncRequest {
  deviceId: string;
  checkins: CheckinRecord[];
}

export interface CheckinSyncResponse {
  checkins: CheckinRecord[];
  conflicts: CheckinConflict[];
}

/** POST /api/checkin/:eventId/claim - one scan attempt asking to admit a ticket. */
export interface CheckinClaimRequest {
  seriesId: string;
  edition: number;
  method: "scan" | "manual";
  /** Random per scan attempt; a retry of the same attempt reuses it. */
  claimId: string;
  /** Device clock at the scan, ISO. Recorded, never trusted for ordering. */
  at: string;
}

export interface CheckinClaimResponse {
  /** "admitted": this attempt holds the ticket. "already-in": another attempt does. */
  status: "admitted" | "already-in";
  /** The record that holds the ticket - this attempt's, or the earlier one. */
  record: CheckinRecord;
  serverTime: string;
}

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

/** Parsed `woco://t/{eventId}/{seriesId}/{edition}/{sig}` QR payload. */
export interface TicketQr {
  eventId: string;
  seriesId: string;
  edition: number;
  sig: string;
}

/**
 * Accepts the `woco://t/...` URI the QR codes carry and the emailed ticket link
 * (`…/ticket.html#{eventId}/{seriesId}/{edition}/{sig}`, see ticket/link.ts), so
 * the camera and a pasted link both work at the door. The old
 * `https://…/t/{eventId}/{seriesId}/{edition}/{sig}` form is not accepted: it
 * put the signature in the request path, and nothing produces it any more.
 */
export function parseTicketQr(raw: string): TicketQr | null {
  const trimmed = raw.trim();

  const wocoMatch = trimmed.match(/^woco:\/\/t\/(.+)$/i);
  if (wocoMatch) {
    const parts = wocoMatch[1].split("/");
    if (parts.length !== 4) return null;
    const [eventId, seriesId, editionStr, sig] = parts;
    const edition = Number(editionStr);
    if (!eventId || !seriesId || !sig) return null;
    if (!Number.isInteger(edition) || edition < 1) return null;
    try {
      return { eventId, seriesId: decodeURIComponent(seriesId), edition, sig };
    } catch {
      return null; // a malformed escape is an unreadable ticket, not a crash at the door
    }
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (!url.pathname.endsWith(TICKET_PAGE_PATH)) return null;
      return parseTicketFragment(url.hash)?.ticket ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Door-pass URL: `{scannerOrigin}/#/p/{token}/{keyB64url}`. */
export function buildDoorPassUrl(scannerOrigin: string, token: string, keyB64url: string): string {
  return `${scannerOrigin.replace(/\/$/, "")}/#/p/${token}/${keyB64url}`;
}

export function parseDoorPassFragment(hash: string): { token: string; keyB64url: string } | null {
  const m = hash.replace(/^#\/?/, "").match(/^p\/([^/]+)\/([^/]+)$/);
  if (!m) return null;
  return { token: m[1], keyB64url: m[2] };
}

/** Token wire format: `v1.{eventIdB64url}.{jti}.{exp}.{tagHex}` — eventId is
 *  base64url-encoded because raw event ids may contain `.` or `/`. */
export function encodeDoorPassToken(payload: DoorPassPayload, tagHex: string): string {
  const eventIdB64 = base64UrlEncode(new TextEncoder().encode(payload.eventId));
  return `${payload.v}.${eventIdB64}.${payload.jti}.${payload.exp}.${tagHex}`;
}

export function decodeDoorPassToken(token: string): { payload: DoorPassPayload; tagHex: string } | null {
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== DOOR_PASS_VERSION) return null;
  const [, eventIdB64, jti, expStr, tagHex] = parts;
  const exp = Number(expStr);
  if (!jti || !Number.isInteger(exp) || !/^[0-9a-f]{64}$/i.test(tagHex)) return null;
  let eventId: string;
  try {
    eventId = new TextDecoder().decode(base64UrlDecode(eventIdB64));
  } catch {
    return null;
  }
  if (!eventId) return null;
  return { payload: { v: DOOR_PASS_VERSION, eventId, jti, exp }, tagHex };
}

/** The exact bytes the door-pass HMAC tag is computed over. */
export function doorPassSigningInput(payload: DoorPassPayload): string {
  return `woco-doorpass-${payload.v}\n${payload.eventId}\n${payload.jti}\n${payload.exp}\n`;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa === "function"
    ? btoa(bin)
    : Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}
