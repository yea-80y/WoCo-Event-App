/**
 * The pairing channel (#746 step 4), client side: the code two devices share, the
 * keys it gives, and the sealed messages they pass (`@woco/shared`
 * auth/device-pairing.ts says what the mailbox enforces).
 *
 * The code is 16 random bytes. HKDF-SHA256 with one label each gives:
 *   - the mailbox id (32 bytes) - what the transport files messages under;
 *   - one AES-256-GCM key per slot - each encrypts exactly one message, and a
 *     message cannot be moved to another slot or pairing.
 * The transport never sees the code, so it can neither read a message nor write
 * one the other device would open.
 *
 * A seed never rides on those keys alone - the code was shown on a screen. It is
 * sealed first (X-Wing, `sealBox`) to a key that exists only in the new device's
 * memory for this one pairing; the code's layer around it proves who wrote it.
 *
 * The transport is a seam: the server mailbox today, anything that stores a few
 * KB under an id tomorrow (a Swarm chunk at an address derived from the code).
 * Nothing it holds is trusted, so swapping it changes no rule.
 *
 * Load lazily: it pulls in the sealed box (lattice code + HPKE).
 */

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { PAIRING_TTL_MS, type PairingSlot } from "@woco/shared";
import { xwing } from "@woco/shared/crypto/xwing";
import { openBox, sealBox, type SealedBoxV2 } from "@woco/shared/crypto/sealed-box";

const LABEL = "woco/device-pairing/v1";
export const PAIRING_QR_PREFIX = "woco-pair:v1:";
const CODE_BYTES = 16;
const CODE_CHARS = 26;

// Crockford base32: no I, L, O or U, so a typed code survives the usual misreads.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const READS_AS: Record<string, string> = { O: "0", I: "1", L: "1" };

export function newPairingCode(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(CODE_BYTES));
}

function encodeCode(code: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const b of code) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/** For reading aloud or typing: five groups of five, then six. */
export function formatPairingCode(code: Uint8Array): string {
  return encodeCode(code).replace(/^(.{5})(.{5})(.{5})(.{5})(.{6})$/, "$1-$2-$3-$4-$5");
}

/** What the QR carries. Deliberately not a URL: a phone's own camera app cannot
 *  start a pairing, only WoCo's scanner, opened on purpose, can. */
export function pairingQrPayload(code: Uint8Array): string {
  return PAIRING_QR_PREFIX + encodeCode(code);
}

/** A scanned QR or a typed code -> the 16 bytes, or null. */
export function parsePairingCode(input: string): Uint8Array | null {
  let s = input.trim();
  if (s.toLowerCase().startsWith(PAIRING_QR_PREFIX)) s = s.slice(PAIRING_QR_PREFIX.length);
  s = s.toUpperCase().replace(/[\s-]/g, "");
  if (s.length !== CODE_CHARS) return null;
  const out = new Uint8Array(CODE_BYTES);
  let acc = 0;
  let bits = 0;
  let n = 0;
  for (const ch of s) {
    const v = ALPHABET.indexOf(READS_AS[ch] ?? ch);
    if (v < 0) return null;
    acc = ((acc << 5) | v) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      out[n++] = (acc >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  // The last character carries 3 bits of the code and 2 of padding: one spelling per code.
  return (acc & ((1 << bits) - 1)) === 0 ? out : null;
}

function derive(code: Uint8Array, info: string): Uint8Array {
  return hkdf(sha256, code, new Uint8Array(0), utf8ToBytes(`${LABEL}/${info}`), 32);
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

export interface PairingChannel {
  /** The mailbox id, lowercase hex. */
  id: string;
  seal(slot: PairingSlot, message: unknown): Promise<string>;
  /** Throws on anything not sealed under this code for this slot. */
  open(slot: PairingSlot, box: string): Promise<unknown>;
}

export function pairingChannel(code: Uint8Array): PairingChannel {
  if (code.length !== CODE_BYTES) throw new Error("pairing code must be 16 bytes");
  const id = bytesToHex(derive(code, "id"));
  const keys = new Map<PairingSlot, Promise<CryptoKey>>();
  const key = (slot: PairingSlot) => {
    let k = keys.get(slot);
    if (!k) {
      k = crypto.subtle.importKey("raw", buf(derive(code, `key/${slot}`)), "AES-GCM", false, ["encrypt", "decrypt"]);
      keys.set(slot, k);
    }
    return k;
  };
  const aad = (slot: PairingSlot) => buf(utf8ToBytes(`${LABEL}/${slot}:${id}`));
  return {
    id,
    async seal(slot, message) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad(slot) },
        await key(slot),
        buf(utf8ToBytes(JSON.stringify(message))),
      );
      const out = new Uint8Array(12 + ct.byteLength);
      out.set(iv);
      out.set(new Uint8Array(ct), 12);
      return b64url(out);
    },
    async open(slot, box) {
      const bytes = fromB64url(box);
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: aad(slot) },
        await key(slot),
        buf(bytes.slice(12)),
      );
      return JSON.parse(new TextDecoder().decode(pt)) as unknown;
    },
  };
}

// ---------------------------------------------------------------------------
// The secret a link hands over, sealed to a key that lives for one pairing
// ---------------------------------------------------------------------------

export interface PairingRecipient {
  publicKeyHex: string;
  /** Memory only; `forget()` it once the answer is open. */
  secretKey: Uint8Array;
  forget(): void;
}

export function newPairingRecipient(): PairingRecipient {
  const { publicKey, secretKey } = xwing.keygen(crypto.getRandomValues(new Uint8Array(32)));
  return { publicKeyHex: bytesToHex(publicKey), secretKey, forget: () => secretKey.fill(0) };
}

export interface LinkSecret {
  parent: string;
  seed: string;
}

function linkContext(id: string, grantee: string) {
  return { info: `${LABEL}/link`, aad: `${LABEL}/link:${id}:${grantee.toLowerCase()}` };
}

export function sealLinkSecret(
  recipientPublicKeyHex: string,
  secret: LinkSecret,
  ctx: { id: string; grantee: string },
): Promise<SealedBoxV2> {
  const plain = utf8ToBytes(JSON.stringify({ v: 1, parent: secret.parent.toLowerCase(), seed: secret.seed }));
  return sealBox(hexToBytes(recipientPublicKeyHex), plain, linkContext(ctx.id, ctx.grantee));
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const SEED = /^(0x)?[0-9a-fA-F]{64}$/;

export async function openLinkSecret(
  recipient: PairingRecipient,
  box: unknown,
  ctx: { id: string; grantee: string },
): Promise<LinkSecret> {
  const plain = await openBox(recipient.secretKey, box, linkContext(ctx.id, ctx.grantee));
  const v = JSON.parse(new TextDecoder().decode(plain)) as { v?: unknown; parent?: unknown; seed?: unknown };
  if (v.v !== 1 || typeof v.parent !== "string" || !ADDRESS.test(v.parent) || typeof v.seed !== "string" || !SEED.test(v.seed)) {
    throw new Error("pairing secret is not in the expected shape");
  }
  return { parent: v.parent, seed: v.seed };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface PairingTransport {
  post(id: string, slot: PairingSlot, box: string): Promise<void>;
  /** The box, null while the slot is empty, "gone" once the pairing expired. */
  read(id: string, slot: PairingSlot): Promise<string | null | "gone">;
}

export class PairingExpiredError extends Error {
  constructor() {
    super("That code has expired, was already used, or was typed wrong. Start again on the other device.");
    this.name = "PairingExpiredError";
  }
}

/** The server mailbox (`/api/pairing`). Plain fetch: no session, no cookies. */
export function httpPairingTransport(base: string, fetchFn: typeof fetch = fetch): PairingTransport {
  const url = (id: string, slot: PairingSlot) => `${base}/api/pairing/${id}/${slot}`;
  return {
    async post(id, slot, box) {
      const res = await fetchFn(url(id, slot), {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ box }),
      });
      if (res.ok) return;
      if (res.status === 410 || res.status === 409) throw new PairingExpiredError();
      throw new Error(res.status === 429 ? "Too many tries just now - wait a minute and start again." : "Couldn't reach WoCo - check your connection and try again.");
    },
    async read(id, slot) {
      const res = await fetchFn(url(id, slot), { credentials: "omit", cache: "no-store" });
      if (res.status === 410) return "gone";
      if (!res.ok) throw new Error(`pairing read failed (${res.status})`);
      const json = (await res.json()) as { data?: { box?: unknown } };
      const box = json.data?.box;
      return typeof box === "string" ? box : null;
    },
  };
}

/**
 * Poll a slot until it is written. Read errors are retried (a phone moving between
 * networks); the pairing's own expiry and the caller's signal end the wait.
 */
export async function waitForSlot(
  transport: PairingTransport,
  id: string,
  slot: PairingSlot,
  opts: { signal?: AbortSignal; intervalMs?: number; deadline?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  const interval = opts.intervalMs ?? 2_000;
  const deadline = opts.deadline ?? Date.now() + PAIRING_TTL_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    if (opts.signal?.aborted) throw new DOMException("Pairing cancelled", "AbortError");
    let got: string | null | "gone" = null;
    try {
      got = await transport.read(id, slot);
    } catch {
      got = null;
    }
    if (got === "gone") throw new PairingExpiredError();
    if (got !== null) return got;
    if (Date.now() >= deadline) throw new PairingExpiredError();
    await sleep(interval);
  }
}
