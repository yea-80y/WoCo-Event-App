/**
 * Client-side verification of a SOC handed to us by the API origin (#156).
 *
 * The gateway path is self-verifying (bee-js's SOC reader rejects a chunk whose
 * recovered signer is not the owner), so it adds no trust. The server fallback
 * used to return a bare payload the client decoded and believed — which made
 * the API origin a trust root for every client-owned feed, on exactly the path
 * a hostile or broken origin can force. Now the server returns the whole SOC
 * and this runs the same three checks bee does: identifier is the one we asked
 * for, span matches the payload, signature recovers to the owner.
 *
 * Pure; takes the wire fields. A rollback (an OLDER genuine chunk served for a
 * NEWER identifier) fails here on the identifier check — the signature covers
 * `identifier ‖ cac`, so the old chunk's signature does not verify for the new
 * identifier.
 */

import { Signature } from "@ethersphere/bee-js";
import { calculateCacAddress, encodeSpan, socSignDigest } from "@woco/shared";

export interface ServedSoc {
  /** hex, with or without 0x — all lowercased inside. */
  owner: string;
  identifier: string;
  signature: string;
  span: string;
  payload: Uint8Array;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) throw new Error("invalid hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
const strip = (h: string) => (h.startsWith("0x") ? h.slice(2) : h).toLowerCase();

export function verifyServedSoc(
  soc: ServedSoc,
  expected: { owner: string; identifier: Uint8Array },
): { ok: true } | { ok: false; reason: string } {
  try {
    const owner = strip(soc.owner);
    if (owner !== strip(expected.owner)) return { ok: false, reason: "owner is not the one requested" };
    const identifier = hexToBytes(soc.identifier);
    if (identifier.length !== 32 || bytesToHex(identifier) !== bytesToHex(expected.identifier)) {
      return { ok: false, reason: "identifier is not the one requested" };
    }
    const span = hexToBytes(soc.span);
    if (bytesToHex(span) !== bytesToHex(encodeSpan(soc.payload.length))) return { ok: false, reason: "span does not match payload" };
    const signature = hexToBytes(soc.signature);
    if (signature.length !== 65) return { ok: false, reason: "signature is not 65 bytes" };
    const digest = socSignDigest(identifier, calculateCacAddress(span, soc.payload));
    const recovered = strip(new Signature(signature).recoverPublicKey(digest).address().toHex());
    if (recovered !== owner) return { ok: false, reason: "signature does not recover to owner" };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `malformed: ${(e as Error)?.message ?? String(e)}` };
  }
}
