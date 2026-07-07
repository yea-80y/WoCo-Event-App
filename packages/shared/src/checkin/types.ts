import type { Hex0x } from "../types.js";

// ---------------------------------------------------------------------------
// Door check-in — shared between server, dashboard, and the scanner PWA.
//
// Trust model:
// - v2 (on-chain) series: the QR sig recovers to the on-chain slotOwner. The
//   scanner verifies this offline against `slotOwners` from the CheckinPack.
// - v1 (Swarm-only) series: the QR sig is the creator's ed25519 edition sig,
//   which is public feed data — it proves the ticket exists, not who holds
//   it. The scanner matches sha256(sig) against the claim ledger and relies
//   on the one-time-use nullifier as the real gate.
// - The roster is AES-GCM ciphertext end-to-end: the key travels only in the
//   door-pass URL fragment and is never sent to the server.
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

/** One check-in — the nullifier unit. Identity is (seriesId, edition). */
export interface CheckinRecord {
  seriesId: string;
  edition: number;
  /** ISO timestamp of the check-in on the recording device. */
  at: string;
  /** Random per-device id — lets sync attribute duplicate offline scans. */
  deviceId: string;
  method: "scan" | "manual";
}

/** Same ticket accepted independently on two offline devices. */
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
  /** Present for v2 series — enables offline ecrecover verification. */
  onChainEventId?: Hex0x;
  /** v2: lowercase owner address per slot (index = edition - 1); zero-address
   *  slots are unclaimed. */
  slotOwners?: string[];
  /** v1: claimed editions with sha256(originalSignature) hex for QR matching. */
  claimedEditions?: Array<{ edition: number; sigHash: string }>;
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
 * Accepts the canonical `woco://t/...` URI and the `https://.../t/...` page
 * URL form (with optional query params / `.png` suffix), so scanning either
 * the emailed PNG QR or a ticket-page link both work at the door.
 */
export function parseTicketQr(raw: string): TicketQr | null {
  const trimmed = raw.trim();
  let path: string | null = null;

  const wocoMatch = trimmed.match(/^woco:\/\/t\/(.+)$/i);
  if (wocoMatch) {
    path = wocoMatch[1];
  } else if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const m = url.pathname.match(/\/t\/(.+)$/);
      if (m) path = m[1];
    } catch {
      return null;
    }
  }
  if (!path) return null;

  const parts = path.replace(/\.png$/i, "").split("/");
  if (parts.length !== 4) return null;
  const [eventId, seriesId, editionStr, sig] = parts;
  const edition = Number(editionStr);
  if (!eventId || !seriesId || !sig) return null;
  if (!Number.isInteger(edition) || edition < 1) return null;
  return { eventId, seriesId: decodeURIComponent(seriesId), edition, sig };
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
