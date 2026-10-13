/**
 * The one byte form of a secp256k1 signature, for hashing INTO a key (#186).
 *
 * The identity seed and a wallet guardian's escrow master are keccak256 of a
 * signature's bytes. One signature has several valid byte forms - v as 0/1 or
 * 27/28, s low or high (EIP-2), 65 bytes or the 64-byte compact form (EIP-2098) -
 * and every form recovers the same address. A wallet that switched form would
 * hand its user a different seed (sealed history stops opening, every owned
 * feed is orphaned) or leave a backup unable to open its escrow, and nothing
 * would say why. Canonical input passes through byte for byte, so no existing
 * key moves.
 */

import { hex0xToBytes } from "../crypto/hex.js";

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function toBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

function to32Bytes(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/** 65 bytes `r || s || v` with s in the lower half of the curve order and v 27/28. */
export function canonicalSignatureBytes(signature: string): Uint8Array {
  const bytes = hex0xToBytes(signature);
  let s: bigint;
  let parity: number;
  if (bytes.length === 65) {
    const v = bytes[64]!;
    if (v === 0 || v === 27) parity = 0;
    else if (v === 1 || v === 28) parity = 1;
    else throw new Error(`canonicalSignatureBytes: unexpected v ${v}`);
    s = toBigInt(bytes.subarray(32, 64));
  } else if (bytes.length === 64) {
    // EIP-2098: the top bit of s carries the parity.
    parity = bytes[32]! >> 7;
    const sBytes = bytes.slice(32, 64);
    sBytes[0]! &= 0x7f;
    s = toBigInt(sBytes);
  } else {
    throw new Error(`canonicalSignatureBytes: expected 64 or 65 bytes, got ${bytes.length}`);
  }
  const r = toBigInt(bytes.subarray(0, 32));
  if (r === 0n || r >= SECP256K1_N || s === 0n || s >= SECP256K1_N) {
    throw new Error("canonicalSignatureBytes: r or s out of range");
  }
  if (s > SECP256K1_N / 2n) {
    s = SECP256K1_N - s;
    parity ^= 1;
  }
  const out = new Uint8Array(65);
  out.set(bytes.subarray(0, 32), 0);
  out.set(to32Bytes(s), 32);
  out[64] = 27 + parity;
  return out;
}
