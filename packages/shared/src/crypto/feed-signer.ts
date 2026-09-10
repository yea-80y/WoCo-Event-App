/**
 * The CONTENT-FEED SIGNER — the secp256k1 key whose address OWNS the user's
 * content chunks (profile, avatar, events, sites, likes, follows).
 *
 * HKDF(sha256, seed, salt = "", info = "woco/feed-signer/v1", 48) → scalar → key.
 * A sibling of the issuing key (`issuing.ts`, info "woco/issuing/v1/{gen}") and
 * the X25519 encryption key (`keys.ts`, info "woco/encryption/v1"), sharing the
 * one construction in `secp-hkdf.ts`.
 *
 * THE INFO STRING IS FROZEN. Change it and every user's SOC owner address moves:
 * their existing chunks stay where they are, under an address nothing will look
 * at any more, while the platform-signed carriers that publish the old address
 * keep pointing at it. That is not a migration, it is an orphaning.
 *
 * THE THREE SIBLINGS ARE INDEPENDENT, and only the info string makes them so.
 * HKDF is one-way, so a leaked feed signer cannot recover the seed and therefore
 * cannot reach the issuing key or the encryption key — which matters here more
 * than for the others, because the feed signer is the key most exposed: it signs
 * on every publish, and it is escrowed for recovery alongside nothing else.
 *
 * WHY THIS IS A KDF AND NO LONGER A SIGNATURE. It used to be sign-to-derive
 * under its own EIP-712 domain — a second deterministic signature, a second
 * wallet prompt, a second at-rest secret to store and escrow, and a
 * "stored copy wins" rule to stop a rotated passkey credential re-deriving a
 * divergent key and orphaning every feed. All of that collapses into the seed:
 * one signature establishes the account, the feed signer falls out of it by
 * KDF, and the anti-divergence rule lives in exactly one place (the seed's
 * AAD-bound slot) instead of two. Recovery gets simpler for the same reason —
 * the escrow bundle carries the seed and nothing else.
 */

import { deriveSecpFromSeed } from "./secp-hkdf.js";
import type { Hex0x } from "../types.js";

/** HKDF info for the content-feed signer. FROZEN — see the file header. */
export const FEED_SIGNER_INFO = "woco/feed-signer/v1";

/**
 * Derive the content-feed signer from the account seed.
 *
 * `privKey` is the 0x-prefixed form the SOC signer and the escrow bundle both
 * speak; `address` is lowercased, because it is the SOC owner and every feed
 * topic and registry value keys off it in lowercase.
 *
 * Throws on a malformed seed, never on a seed VALUE. Callers without a seed must
 * FAIL LOUD — a platform signer is not a fallback, it is a different owner.
 */
export function deriveFeedSignerKey(seedHex: string): { privKey: Hex0x; address: string } {
  const { privateKey, address } = deriveSecpFromSeed(seedHex, FEED_SIGNER_INFO, "account seed");
  let hex = "";
  for (const b of privateKey) hex += b.toString(16).padStart(2, "0");
  return { privKey: `0x${hex}` as Hex0x, address: address.toLowerCase() };
}
