/**
 * EIP-191 personal-sign over keccak256(data): the signature Swarm requires for
 * postage stamps (over address || batchId || index || timestamp) and for
 * single-owner chunks (over identifier || CAC address). Bee recovers the signer
 * from `"\x19Ethereum Signed Message:\n32" || keccak256(data)`.
 *
 * On noble's audited secp256k1 rather than the BigInt ECDSA inside bee-js
 * (cafe-utility `Elliptic`): that one is sound (deterministic nonces, low-s) but
 * branches on secret bits and has no independent audit, and these keys sign on
 * request paths anyone can trigger. Nonces are RFC 6979; s is low by default.
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";

const PREFIX_32 = utf8ToBytes("\x19Ethereum Signed Message:\n32");

/** The 32-byte hash that is actually signed. */
export function personalSignKeccakDigest(data: Uint8Array): Uint8Array {
  return keccak_256(concatBytes(PREFIX_32, keccak_256(data)));
}

/** Ethereum wire form r(32) || s(32) || v(1), v in {27, 28}, low-s. */
export function personalSignKeccak(data: Uint8Array, privateKey: Uint8Array): Uint8Array {
  // noble v2 'recovered' layout is [recovery, r, s]; Ethereum wants r || s || v.
  const sig = secp256k1.sign(personalSignKeccakDigest(data), privateKey, { prehash: false, format: "recovered" });
  const out = new Uint8Array(65);
  out.set(sig.subarray(1), 0);
  out[64] = sig[0]! + 27;
  return out;
}
