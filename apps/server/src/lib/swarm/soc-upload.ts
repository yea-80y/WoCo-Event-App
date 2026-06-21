/**
 * Client-signed Single-Owner-Chunk (SOC) stamp+upload + read (Phase A of
 * CLIENT_FEED_SIGNER_HANDOVER.md).
 *
 * The client OWNS the SOC key and signs the chunk locally; the server only holds
 * the postage batch, so it STAMPS and UPLOADS the pre-signed chunk. Before
 * stamping, the server independently re-derives the content-addressed (CAC)
 * address from the submitted span+payload and verifies the client's signature
 * recovers to the claimed owner over `concat(identifier, cacAddress)` — so it can
 * never be tricked into stamping bytes the owner didn't sign. Bee re-validates the
 * signature on upload too (defence in depth).
 *
 * Authorization rule: ANY authenticated user may stamp their OWN validly-signed
 * SOC. The SOC owner is a key the client controls (for the recovery envelope, a
 * PRF-derived key that is NOT the parent address), so we cannot bind owner ==
 * authenticated parent. Abuse is bounded by (a) auth-gating the endpoint, (b) the
 * signature-must-verify check, and (c) postage cost. Reads are unauthenticated —
 * SOCs are public on Swarm and the envelope payload is HPKE-sealed (useless
 * without the passkey).
 *
 * Etherna-safe by construction: the payload is carried INLINE (never a ref-style
 * SOC), and reads resolve by COMPUTED CHUNK ADDRESS via makeSOCReader (GET
 * /chunks/{addr}), never via /feeds (which 401s anonymously on Etherna). Phase A
 * stays on our own Bee (getBee); the read shape works identically on both.
 */

import { Signature } from "@ethersphere/bee-js";
import {
  calculateCacAddress,
  calculateSocAddress,
  socSignDigest,
  encodeSpan,
  SOC_IDENTIFIER_SIZE,
  SOC_SIGNATURE_SIZE,
  SOC_MAX_PAYLOAD_SIZE,
} from "@woco/shared";
import { BEE_URL, getBee, requirePostageBatch } from "../../config/swarm.js";
import { BEE_CALL_TIMEOUT_MS, beeUploadSem, withTimeout } from "./upload-queue.js";
import { whitelistHashes } from "./whitelist.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HEX_RE = /^[0-9a-fA-F]+$/;

function hexToBytes(hex: string, expectedLen?: number): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length === 0 || clean.length % 2 !== 0 || !HEX_RE.test(clean)) {
    throw new Error("invalid hex");
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  if (expectedLen !== undefined && bytes.length !== expectedLen) {
    throw new Error(`expected ${expectedLen} bytes, got ${bytes.length}`);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export interface SignedSocInput {
  /** Owner Ethereum address (hex, 20 bytes; with or without 0x). */
  owner: string;
  /** SOC identifier (hex, 32 bytes). */
  identifier: string;
  /** secp256k1 SOC signature (hex, 65 bytes). */
  signature: string;
  /** Little-endian uint64 span (hex, 8 bytes) — MUST equal encodeSpan(payload.length). */
  span: string;
  /** Inline chunk payload (hex, 1..4096 bytes). */
  payload: string;
}

export interface SocReference {
  /** Lowercased owner address (no 0x). */
  owner: string;
  /** SOC identifier (hex, no 0x). */
  identifier: string;
  /** The SOC's own Swarm address keccak256(identifier||owner) (hex, no 0x). */
  address: string;
}

/**
 * Validate a client-signed SOC and, if sound, stamp + upload it to our Bee.
 * Throws `Error` with a `status` field for client-side (400) validation faults.
 */
export async function uploadSignedSoc(input: SignedSocInput): Promise<SocReference> {
  let owner: Uint8Array, identifier: Uint8Array, signature: Uint8Array, span: Uint8Array, payload: Uint8Array;
  try {
    owner = hexToBytes(input.owner, 20);
    identifier = hexToBytes(input.identifier, SOC_IDENTIFIER_SIZE);
    signature = hexToBytes(input.signature, SOC_SIGNATURE_SIZE);
    span = hexToBytes(input.span, 8);
    payload = hexToBytes(input.payload);
  } catch (e) {
    const err = new Error(`Invalid SOC field: ${(e as Error).message}`) as Error & { status: number };
    err.status = 400;
    throw err;
  }

  if (payload.length < 1 || payload.length > SOC_MAX_PAYLOAD_SIZE) {
    const err = new Error(`SOC payload must be 1..${SOC_MAX_PAYLOAD_SIZE} bytes`) as Error & { status: number };
    err.status = 400;
    throw err;
  }
  // Span MUST describe the payload length — otherwise the signed CAC address
  // wouldn't match the bytes we upload, and the chunk would be unreadable.
  if (bytesToHex(span) !== bytesToHex(encodeSpan(payload.length))) {
    const err = new Error("SOC span does not match payload length") as Error & { status: number };
    err.status = 400;
    throw err;
  }

  // Re-derive the CAC address and verify the signature recovers to `owner` over
  // concat(identifier, cacAddress). This is the gate: a mismatched owner/payload
  // is rejected before any postage is spent.
  const cacAddress = calculateCacAddress(span, payload);
  const digest = socSignDigest(identifier, cacAddress);
  let recovered: string;
  try {
    recovered = new Signature(signature).recoverPublicKey(digest).address().toHex().toLowerCase();
  } catch {
    const err = new Error("SOC signature is malformed") as Error & { status: number };
    err.status = 400;
    throw err;
  }
  const ownerHex = bytesToHex(owner).toLowerCase();
  if (recovered.replace(/^0x/, "") !== ownerHex) {
    const err = new Error("SOC signature does not match owner") as Error & { status: number };
    err.status = 400;
    throw err;
  }

  // Body = span || payload (the CAC bytes); signature rides in the ?sig= query.
  const body = new Uint8Array(span.length + payload.length);
  body.set(span);
  body.set(payload, span.length);
  const identifierHex = bytesToHex(identifier);
  const sigHex = bytesToHex(signature);
  const url = `${BEE_URL}/soc/${ownerHex}/${identifierHex}?sig=${sigHex}`;

  let delay = 500;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      // Hold the semaphore only for the HTTP call, never across the back-off
      // sleep below (mirrors bytes.ts so a throttled slot frees immediately).
      const release = await beeUploadSem.acquire();
      let resp: Response;
      try {
        resp = await withTimeout(
          fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              "Swarm-Postage-Batch-Id": requirePostageBatch(),
            },
            body,
          }),
          BEE_CALL_TIMEOUT_MS,
          "soc upload",
        );
      } finally {
        release();
      }
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        const e = new Error(`Bee SOC upload ${resp.status}: ${text.slice(0, 200)}`) as Error & { status?: number };
        // 429 / 5xx are transient; surface other 4xx immediately as a 502.
        if (!(resp.status === 429 || resp.status >= 500)) e.status = 502;
        throw e;
      }
      const socAddress = bytesToHex(calculateSocAddress(identifier, owner));
      // Whitelist the SOC address on the read proxy so ANY device can read it
      // directly from the gateway (GET /chunks/{addr}) — the client reads
      // gateway-first, server-fallback. Non-fatal: the chunk is uploaded
      // regardless, and the server read endpoint covers a whitelist lag.
      try {
        await whitelistHashes([socAddress]);
      } catch (e) {
        console.warn("[swarm] SOC whitelist failed (non-fatal, server-read fallback covers it):", e);
      }
      return { owner: ownerHex, identifier: identifierHex, address: socAddress };
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string; status?: number };
      const transient =
        e?.status === undefined &&
        (e?.code === "ETIMEDOUT" ||
          /429|socket hang up|network|timeout/i.test(String(e?.message ?? "")) ||
          ["ECONNRESET", "ECONNABORTED", "EAI_AGAIN"].includes(String(e?.code ?? "")));
      // 429/5xx errors are thrown without a `status` (only true 4xx get status=502).
      const beeTransient = /\b(429|5\d\d)\b/.test(String(e?.message ?? "")) && e?.status === undefined;
      if ((transient || beeTransient) && attempt < 4) {
        await wait(delay);
        delay = Math.min(delay * 2, 5000);
        continue;
      }
      throw err;
    }
  }
  throw new Error("SOC upload failed after retries");
}

/**
 * Read a SOC's inline payload by computed chunk address (Etherna-safe). Returns
 * the raw payload bytes, or null if the chunk is not found.
 */
export async function readSocPayload(ownerHex: string, identifierHex: string): Promise<Uint8Array | null> {
  let owner: string, identifier: string;
  try {
    owner = bytesToHex(hexToBytes(ownerHex, 20));
    identifier = bytesToHex(hexToBytes(identifierHex, SOC_IDENTIFIER_SIZE));
  } catch {
    const err = new Error("Invalid owner or identifier") as Error & { status: number };
    err.status = 400;
    throw err;
  }
  try {
    const soc = await getBee().makeSOCReader(owner).download(identifier);
    return soc.payload.toUint8Array();
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status ?? (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) return null;
    const msg = String((err as Error)?.message ?? "").toLowerCase();
    if (msg.includes("not found") || msg.includes("404")) return null;
    throw err;
  }
}
