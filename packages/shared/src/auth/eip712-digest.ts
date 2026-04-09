/**
 * Minimal dependency-free EIP-712 digest computation.
 *
 * Used in contexts where ethers is not available (e.g. the embed widget,
 * which signs claim messages with noble/curves secp256k1 directly).
 * The server still verifies via ethers `verifyTypedData`, so the outputs
 * here MUST be byte-identical to what ethers produces for the same input.
 *
 * Currently supports only the field types WoCo uses: `string`, `address`,
 * `uint256`, `bytes32`. Extending to dynamic arrays / nested structs
 * requires revisiting `encodeField`.
 *
 * References:
 *   - EIP-712:            https://eips.ethereum.org/EIPS/eip-712
 *   - ethers encoder:     https://github.com/ethers-io/ethers.js/blob/main/src.ts/hash/typed-data.ts
 */

import { keccak_256 } from "@noble/hashes/sha3";

export interface EIP712TypeField {
  name: string;
  type: string;
}

export interface EIP712Domain {
  name?: string;
  version?: string;
  chainId?: number | bigint;
  verifyingContract?: string;
  salt?: string;
}

// ---------------------------------------------------------------------------
// Primitive encoders (all return exactly 32 bytes)
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error(`invalid hex length: ${hex}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "0x";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

function leftPad32(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 32) throw new Error("value exceeds 32 bytes");
  if (bytes.length === 32) return bytes;
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
}

function encodeUint256(value: number | bigint | string): Uint8Array {
  let b: bigint;
  if (typeof value === "bigint") b = value;
  else if (typeof value === "number") b = BigInt(value);
  else b = BigInt(value);
  if (b < 0n) throw new Error("uint256 cannot be negative");

  const hex = b.toString(16);
  return leftPad32(hexToBytes(hex.length % 2 === 0 ? hex : "0" + hex));
}

function encodeAddress(value: string): Uint8Array {
  const bytes = hexToBytes(value);
  if (bytes.length !== 20) throw new Error(`invalid address length: ${value}`);
  return leftPad32(bytes);
}

function encodeBytes32(value: string): Uint8Array {
  const bytes = hexToBytes(value);
  if (bytes.length !== 32) throw new Error(`invalid bytes32 length: ${value}`);
  return bytes;
}

function encodeString(value: string): Uint8Array {
  return keccak_256(enc.encode(value));
}

// ---------------------------------------------------------------------------
// Type encoding & struct hashing
// ---------------------------------------------------------------------------

/**
 * Encode a single field to its 32-byte form per EIP-712.
 * Only primitive leaf types are supported — nested structs / arrays would
 * need a recursive encoder.
 */
function encodeField(type: string, value: unknown): Uint8Array {
  switch (type) {
    case "string":
      if (typeof value !== "string") throw new Error(`expected string for ${type}`);
      return encodeString(value);
    case "address":
      if (typeof value !== "string") throw new Error(`expected address for ${type}`);
      return encodeAddress(value);
    case "bytes32":
      if (typeof value !== "string") throw new Error(`expected bytes32 hex for ${type}`);
      return encodeBytes32(value);
    default:
      if (/^uint\d*$/.test(type) || /^int\d*$/.test(type)) {
        if (typeof value !== "number" && typeof value !== "bigint" && typeof value !== "string") {
          throw new Error(`expected numeric for ${type}`);
        }
        return encodeUint256(value as number | bigint | string);
      }
      throw new Error(`eip712-digest: unsupported field type "${type}"`);
  }
}

/** Build the EIP-712 type string `TypeName(type1 name1,type2 name2,...)`. */
function buildTypeString(primaryType: string, fields: readonly EIP712TypeField[]): string {
  return `${primaryType}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
}

/** `typeHash = keccak256(typeString)` */
function typeHash(primaryType: string, fields: readonly EIP712TypeField[]): Uint8Array {
  return keccak_256(enc.encode(buildTypeString(primaryType, fields)));
}

/** `structHash = keccak256(typeHash || enc(field1) || enc(field2) ...)` */
function hashStruct(
  primaryType: string,
  fields: readonly EIP712TypeField[],
  message: Record<string, unknown>,
): Uint8Array {
  const parts: Uint8Array[] = [typeHash(primaryType, fields)];
  for (const f of fields) {
    parts.push(encodeField(f.type, message[f.name]));
  }
  return keccak_256(concat(parts));
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Build the domain separator from the present domain fields.
 * Must include exactly the fields that are defined (non-undefined) on the
 * domain object, in the canonical order per EIP-712.
 */
function domainSeparator(domain: EIP712Domain): Uint8Array {
  const fields: EIP712TypeField[] = [];
  if (domain.name !== undefined) fields.push({ name: "name", type: "string" });
  if (domain.version !== undefined) fields.push({ name: "version", type: "string" });
  if (domain.chainId !== undefined) fields.push({ name: "chainId", type: "uint256" });
  if (domain.verifyingContract !== undefined)
    fields.push({ name: "verifyingContract", type: "address" });
  if (domain.salt !== undefined) fields.push({ name: "salt", type: "bytes32" });

  return hashStruct(
    "EIP712Domain",
    fields,
    domain as unknown as Record<string, unknown>,
  );
}

/**
 * Compute the EIP-712 signing digest:
 *   keccak256(0x1901 || domainSeparator || hashStruct(primaryType, message))
 */
export function eip712Digest(
  domain: EIP712Domain,
  primaryType: string,
  fields: readonly EIP712TypeField[],
  message: Record<string, unknown>,
): Uint8Array {
  const dSep = domainSeparator(domain);
  const sHash = hashStruct(primaryType, fields, message);
  const prefix = new Uint8Array([0x19, 0x01]);
  return keccak_256(concat([prefix, dSep, sHash]));
}

/** Hex form (with `0x`) of `eip712Digest`. */
export function eip712DigestHex(
  domain: EIP712Domain,
  primaryType: string,
  fields: readonly EIP712TypeField[],
  message: Record<string, unknown>,
): string {
  return bytesToHex(eip712Digest(domain, primaryType, fields, message));
}
