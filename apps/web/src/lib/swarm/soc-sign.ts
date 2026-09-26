/**
 * Building and signing a single-owner chunk (SOC) - no I/O.
 *
 * Split from `client-soc.ts` (#689) for the reason #658 split reading out: that
 * module uploads through the authenticated API client, which reaches the Svelte
 * auth store, which the node test runner cannot load. Signing needs none of it,
 * so the real signer runs in tests and only the transport is replaced.
 */

import { Bee, PrivateKey, Bytes, Span, Identifier, Reference } from "@ethersphere/bee-js";
import { calculateCacAddress, encodeSpan, SOC_MAX_PAYLOAD_SIZE } from "@woco/shared";

// Only `makeSingleOwnerChunk` uses this instance, and it does no I/O.
let _bee: Bee | null = null;
function bee(): Bee {
  if (!_bee) _bee = new Bee("https://gateway.woco-net.com");
  return _bee;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** A signed SOC as `POST /api/swarm/soc` takes it. All hex. */
export type SignedSocBody = {
  owner: string;
  identifier: string;
  signature: string;
  span: string;
  payload: string;
};

/**
 * Sign a SOC with `signerPrivKey` over `{ identifier, payload }`. `identifier`
 * must be 32 bytes; `payload` 1..4096 bytes, carried inline.
 */
export function signSoc(args: { signerPrivKey: string; identifier: Uint8Array; payload: Uint8Array }): SignedSocBody {
  const { signerPrivKey, identifier, payload } = args;
  if (identifier.length !== 32) throw new Error("SOC identifier must be 32 bytes");
  if (payload.length < 1 || payload.length > SOC_MAX_PAYLOAD_SIZE) {
    throw new Error(`SOC payload must be 1..${SOC_MAX_PAYLOAD_SIZE} bytes`);
  }

  const signer = new PrivateKey(signerPrivKey.startsWith("0x") ? signerPrivKey : `0x${signerPrivKey}`);
  const span = encodeSpan(payload.length);
  const cacAddress = calculateCacAddress(span, payload);
  const soc = bee().makeSingleOwnerChunk(
    new Reference(cacAddress),
    Span.fromBigInt(BigInt(payload.length)),
    new Bytes(payload),
    new Identifier(identifier),
    signer,
  );
  return {
    owner: soc.owner.toHex(),
    identifier: soc.identifier.toHex(),
    signature: soc.signature.toHex(),
    span: bytesToHex(span),
    payload: bytesToHex(payload),
  };
}
