/**
 * 0x-prefixed hex helpers — relocated verbatim from `pod/canonical.ts` ahead
 * of the v1 module's deletion (issuer-curve migration PR 5a). Curve- and
 * format-agnostic: OZ's merkle-tree wants 0x-prefixed strings, Swarm and the
 * chain seams want bytes, and both rails' digests travel through these.
 */

const HEX_LOOKUP = "0123456789abcdef";

export function bytesToHex0x(bytes: Uint8Array): string {
  let out = "0x";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += HEX_LOOKUP[b >>> 4]! + HEX_LOOKUP[b & 0xf]!;
  }
  return out;
}

export function hex0xToBytes(hex: string): Uint8Array {
  const s = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (s.length % 2 !== 0) throw new Error(`hex0xToBytes: odd-length input`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = parseInt(s[i * 2]!, 16);
    const lo = parseInt(s[i * 2 + 1]!, 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) {
      throw new Error(`hex0xToBytes: bad hex char at ${i * 2}`);
    }
    out[i] = (hi << 4) | lo;
  }
  return out;
}
