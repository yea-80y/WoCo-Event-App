/**
 * Server-only sealing of a raw claimer wallet address into a pending-claims
 * entry. Public feeds carry only HMAC handles (see hashWalletAddress), but the
 * approve path needs the raw address back — for gate binding and the user's
 * collection feed — and pending entries live on a publicly derivable feed, so
 * the raw address rides sealed.
 *
 * AES-256-GCM under a key HKDF-derived from EMAIL_HASH_SECRET (own info
 * string — independent of the HMAC uses of the same secret). The AAD binds
 * the ciphertext to its {seriesId, pendingId}, so a sealed address cannot be
 * spliced from one pending entry into another: unseal with the wrong context
 * fails authentication and returns null. Random 96-bit IV per seal — the
 * NIST 2^32-invocations bound is nowhere near pending-claim volumes.
 * Rotating EMAIL_HASH_SECRET orphans outstanding sealed addresses as well as
 * every email hash (already documented).
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const IV_LEN = 12;
const TAG_LEN = 16;

function sealKey(): Buffer {
  const secret = process.env.EMAIL_HASH_SECRET;
  if (!secret) {
    // index.ts refuses to start without the env var; this is a backstop.
    throw new Error("EMAIL_HASH_SECRET is not set");
  }
  return Buffer.from(hkdfSync("sha256", secret, "", "woco/claimer-seal/v1", 32));
}

function aad(seriesId: string, pendingId: string): Buffer {
  return Buffer.from(`woco/claimer-seal/v1:${seriesId}:${pendingId}`, "utf8");
}

export function sealClaimer(raw: string, seriesId: string, pendingId: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", sealKey(), iv);
  cipher.setAAD(aad(seriesId, pendingId));
  const ct = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

/** Returns null on malformed, tampered, or wrong-context input — callers must fall back. */
export function unsealClaimer(sealed: string, seriesId: string, pendingId: string): string | null {
  try {
    const buf = Buffer.from(sealed, "base64");
    if (buf.length < IV_LEN + TAG_LEN + 1) return null;
    const decipher = createDecipheriv("aes-256-gcm", sealKey(), buf.subarray(0, IV_LEN));
    decipher.setAAD(aad(seriesId, pendingId));
    decipher.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN));
    return Buffer.concat([
      decipher.update(buf.subarray(IV_LEN + TAG_LEN)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}
