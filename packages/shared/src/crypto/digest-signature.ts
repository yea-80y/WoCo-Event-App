/**
 * Raw secp256k1 signatures over EIP-712 typed statements, computed without ethers.
 * Wire form r(32) || s(32) || v(1), v in {27, 28}, low-s - byte-identical to ethers'
 * `signTypedData` for the same message (RFC 6979).
 *
 * Both functions take the STRUCTURED statement and hash it themselves, never a
 * caller-supplied digest: a raw-digest signer could be pointed at any 32 bytes,
 * including a Swarm SOC digest (`crypto/issuing.ts` forbids that scheme). The EIP-712
 * envelope's 0x1901 prefix keeps every preimage here disjoint from SOC and
 * personal-sign messages.
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { eip712Digest, type EIP712Domain, type EIP712TypeField } from "../auth/eip712-digest.js";

const SIG_RE = /^0x[0-9a-f]{130}$/;

export interface TypedStatement {
  domain: EIP712Domain;
  primaryType: string;
  fields: readonly EIP712TypeField[];
  message: Record<string, unknown>;
}

/** Sign a typed statement. Returns the 0x-prefixed 65-byte wire form. */
export function signTypedStatement(statement: TypedStatement, privateKey: Uint8Array): string {
  const digest = eip712Digest(statement.domain, statement.primaryType, statement.fields, statement.message);
  // noble v2 'recovered' layout is [recovery, r, s]; Ethereum wants r || s || v.
  const sig = secp256k1.sign(digest, privateKey, { prehash: false, format: "recovered" });
  const out = new Uint8Array(65);
  out.set(sig.subarray(1), 0);
  out[64] = sig[0]! + 27;
  return `0x${bytesToHex(out)}`;
}

/**
 * The lowercase address that signed `statement`, or null for anything that is not a
 * canonical signature: wrong length or case, v outside {27, 28}, or a high-s value
 * (the malleable twin of a valid signature).
 */
export function recoverTypedStatementSigner(statement: TypedStatement, signature: unknown): string | null {
  try {
    if (typeof signature !== "string" || !SIG_RE.test(signature)) return null;
    const digest = eip712Digest(statement.domain, statement.primaryType, statement.fields, statement.message);
    const raw = hexToBytes(signature.slice(2));
    const v = raw[64]!;
    if (v !== 27 && v !== 28) return null;
    const recovered = new Uint8Array(65);
    recovered[0] = v - 27;
    recovered.set(raw.subarray(0, 64), 1);
    const sig = secp256k1.Signature.fromBytes(recovered, "recovered");
    if (sig.hasHighS()) return null;
    const pub = sig.recoverPublicKey(digest).toBytes(false);
    return "0x" + bytesToHex(keccak_256(pub.subarray(1)).subarray(12));
  } catch {
    return null;
  }
}
