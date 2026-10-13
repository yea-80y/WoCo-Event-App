/**
 * ENS contenthash encoding for a Swarm BZZ hash (EIP-1577 / ENSIP-7), with no
 * other imports so the CCIP gateway (pure, no chain or env) can use it.
 * Layout: swarm-manifest codec varint (0xe4,0x01=228) | version 0x01 | network
 * varint (0xfa,0x01=250) | keccak-256 code 0x1b | hash length 0x20 | 32-byte hash
 */
const SWARM_ENS_PREFIX = Buffer.from("e40101fa011b20", "hex");
const SWARM_ENS_PREFIX_HEX = SWARM_ENS_PREFIX.toString("hex");

export function encodeSwarmContenthash(hexHash: string): Uint8Array {
  const clean = hexHash.replace(/^0x/, "");
  if (!/^[a-f0-9]{64}$/i.test(clean)) throw new Error("Swarm hash must be 64 hex chars (32 bytes)");
  return Buffer.concat([SWARM_ENS_PREFIX, Buffer.from(clean, "hex")]);
}

/** Reverse of encodeSwarmContenthash — recovers the 64-hex Swarm hash, or null for a
 *  non-Swarm / empty record. Exact length: a trailing byte is not a Swarm record. */
export function decodeSwarmContenthash(contenthash: string): string | null {
  const clean = (contenthash || "").replace(/^0x/, "").toLowerCase();
  if (!clean.startsWith(SWARM_ENS_PREFIX_HEX)) return null;
  const hash = clean.slice(SWARM_ENS_PREFIX_HEX.length);
  return /^[a-f0-9]{64}$/.test(hash) ? hash : null;
}
