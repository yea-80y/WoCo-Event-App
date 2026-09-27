/**
 * The v2 sealed box's SHAPE, and nothing else (#642). Dependency-free on purpose:
 * the server's "is this sealed?" checks import it without loading the lattice code
 * or HPKE, which only the code that actually seals or opens needs
 * (`sealed-box.ts`, which re-exports everything here).
 */

export const SEALED_BOX_VERSION = 2 as const;

/** The X-Wing ciphertext length a v2 box's `enc` carries. `test/crypto/xwing.test.ts`
 *  pins it equal to `XWING_CIPHERTEXT_BYTES`, so the two cannot drift. */
export const SEALED_BOX_ENC_BYTES = 1120;

/** GCM tag length: the smallest `ct` any box can have (an empty plaintext). */
const TAG_BYTES = 16;
const HEX_RE = /^[0-9a-f]*$/;

export interface SealedBoxV2 {
  v: typeof SEALED_BOX_VERSION;
  /** HPKE encapsulated key = the X-Wing ciphertext (1120 bytes, hex). */
  enc: string;
  /** AES-256-GCM ciphertext with its 16-byte tag appended (hex). */
  ct: string;
}

/**
 * A v2 box by SHAPE — for the code that must tell "sealed" from "plain" before it
 * has a key (a server refusing to store cleartext). Shape only: it proves nothing
 * about who sealed it or whether it opens.
 *
 * EXACTLY the three fields. A box with anything beside them is refused, so a
 * "sealed, therefore safe to store" check can never wave through cleartext riding
 * next to a valid box. (A check that must refuse anything that merely CONTAINS a
 * box — the social participant registry — wants the opposite, lenient test, and
 * keeps its own.)
 */
export function isSealedBoxV2(x: unknown): x is SealedBoxV2 {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const b = x as Record<string, unknown>;
  return (
    Object.keys(b).length === 3 &&
    b.v === SEALED_BOX_VERSION &&
    typeof b.enc === "string" &&
    b.enc.length === SEALED_BOX_ENC_BYTES * 2 &&
    HEX_RE.test(b.enc) &&
    typeof b.ct === "string" &&
    b.ct.length >= TAG_BYTES * 2 &&
    b.ct.length % 2 === 0 &&
    HEX_RE.test(b.ct)
  );
}
