/**
 * The ed25519 HOLDER key — the last rail that still needs one.
 *
 * It signs nothing on any launch path (#518). A ticket is signed by its
 * per-purchase secp256k1 BURNER key and verified against the on-chain
 * `slotOwner`; editions and manifests are signed by the secp256k1 ISSUING key.
 * What is left is `woco.credit.v1` (`holderSig` on a ride statement) and the
 * `woco.cert-challenge.v1` possession proof — both OUT of launch scope, both
 * frozen formats that specify ed25519, so the key survives here until those
 * rails migrate to secp256k1 and this file goes with them.
 *
 * DERIVED, NEVER STORED. The 32-byte account seed IS the ed25519 secret key
 * (used verbatim, no KDF — that is what the frozen credit/cert vectors pin), so
 * a caller holding the seed can produce this keypair on demand and drop it. It
 * is a sibling of the X25519 encryption key (`crypto/keys.ts`, HKDF info
 * "woco/encryption/v1"), the secp256k1 issuing key (`crypto/issuing.ts`, info
 * "woco/issuing/v1/{gen}") and the content-feed signer — none of which can be
 * recovered from this one.
 *
 * `@noble/ed25519` is imported DYNAMICALLY and must stay that way: this rail is
 * unreachable at launch, and a static import drags the curve into the eager
 * bundle for every visitor who will never sign a ride. A source test
 * (`apps/web/test/no-eager-ed25519.test.ts`) fails if any other file imports the
 * package, or if this one imports it statically.
 */

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/**
 * The 32-byte ed25519 secret key for an account seed. The seed is the key —
 * no derivation step — so any change here forks every existing credit
 * statement and cert challenge.
 */
export function seedToEd25519(seedHex: string): Uint8Array {
  const clean = seedHex.startsWith("0x") || seedHex.startsWith("0X") ? seedHex.slice(2) : seedHex;
  const bytes = hexToBytes(clean);
  if (bytes.length !== 32) {
    throw new Error(`Invalid seed: expected 32 bytes, got ${bytes.length}`);
  }
  return bytes;
}

/**
 * Derive the holder keypair from an account seed.
 *
 * `publicKeyHex` is 0x-prefixed for consistency with every other hex value in
 * the app; `woco.credit.v1` and `woco.cert-challenge.v1` both validate `holder`
 * against a BARE 64-hex pattern, so those callers strip it (credits.ts says
 * why at its own call site).
 */
export async function deriveHolderKeypair(seedHex: string): Promise<{
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  publicKeyHex: string;
}> {
  const privateKey = seedToEd25519(seedHex);
  // Dynamic by design — see the file header.
  const ed = await import("@noble/ed25519");
  const publicKey = await ed.getPublicKeyAsync(privateKey);

  return {
    privateKey,
    publicKey,
    publicKeyHex: "0x" + bytesToHex(publicKey),
  };
}
