/**
 * On-chain ticketing v1 — POD + manifest schemas.
 *
 * `woco.ticket.v2` PODs are pre-signed at event creation as a Merkle-tree
 * batch under a single `woco.manifest.v1`. There is no per-POD signature;
 * authenticity comes from (a) the ed25519-signed manifest, (b) the chain
 * commitment to `manifestRef = keccak256(dagCbor(manifestBody))`, and
 * (c) a Merkle proof from the POD's leaf to `manifestBody.metadataRoot`.
 *
 * The cryptographic surface (encoder, leaf format, tree scheme, signature
 * domain) is locked. See `canonical.ts` and `merkle.ts` for the producer/
 * consumer code that ships in v1 — DO NOT change without a format bump.
 */

/** Hex-encoded ed25519 public key (32 bytes, lowercase, no 0x prefix). */
export type Hex32 = string;

/** 0x-prefixed bytes32 hex (66 chars including 0x). */
export type Bytes32Hex = string;

/**
 * `woco.ticket.v2` POD body — pre-signed at event creation.
 *
 * No `claimedBy` field: ownership is recorded on chain
 * (`slotOwner[eventId][slot]`), not in the POD. No per-POD signature: the
 * manifest signs the Merkle root of all leaves, and each leaf binds the
 * edition number to the canonical CBOR encoding of this body.
 */
export interface PodV2Body {
  format: "woco.ticket.v2";
  eventId: Bytes32Hex;
  seriesId: string;
  /** 1-indexed edition number (1..totalSupply). Bound into the leaf hash. */
  edition: number;
  /**
   * Ticket metadata — name, image, description, anything the organiser wants
   * the buyer to see. Free-form so PODs can carry arbitrary asset payloads
   * for the long-term composability story.
   */
  metadata: Record<string, unknown>;
  /** ed25519 issuer public key (hex, lowercase, no 0x). Mirrors manifest. */
  issuer: Hex32;
}

/**
 * `woco.manifest.v1` body — signed by the organiser's ed25519 key.
 *
 * The signed payload is `keccak256(dagCbor(this body))` (32 bytes). That same
 * digest is what the chain stores as `manifestRef` in `WoCoEvent.events`,
 * binding the signature to the on-chain commitment.
 */
export interface ManifestV1Body {
  format: "woco.manifest.v1";
  /** 0x-prefixed bytes32 — matches the on-chain eventId derived in registerEvent. */
  eventId: Bytes32Hex;
  totalSupply: number;
  /** ed25519 issuer pubkey (hex, lowercase, no 0x). */
  issuerPubkey: Hex32;
  /** 0x-prefixed bytes32 — Merkle root over all edition leaves. */
  metadataRoot: Bytes32Hex;
  /** Locked encoder identifier — only `cbor-v1` ships in v1. */
  encoding: "cbor-v1";
  /**
   * Locked tree scheme identifier.
   * `oz-simple-v1`: leaves used verbatim (already hashed by us); internal
   * nodes are `keccak256(sort(L, R))`; non-power-of-2 supplies use OZ's
   * unbalanced tree shape (no padding leaves). Matches
   * `@openzeppelin/merkle-tree`'s `SimpleMerkleTree` default.
   */
  treeScheme: "oz-simple-v1";
  /**
   * Optional shared metadata template — purely informational. Each POD's own
   * `metadata` is what's committed to via Merkle proof. The template helps
   * humans read the manifest without fetching every POD.
   */
  podTemplate?: Record<string, unknown>;
}

/**
 * Signed manifest envelope — what gets uploaded to Swarm.
 *
 * Verifiers split `body` from `signature`, recompute `keccak256(dagCbor(body))`,
 * and check (a) ed25519 sig with `body.issuerPubkey` and (b) chain
 * `manifestRef == that digest`. The signature itself is NOT in the signed bytes.
 */
export interface SignedManifestV1 {
  body: ManifestV1Body;
  /** ed25519 signature (hex, lowercase, no 0x prefix; 64 bytes). */
  signature: string;
}

/**
 * Per-edition Merkle proof. Carried alongside a POD when a verifier needs to
 * confirm membership in `manifestBody.metadataRoot` without holding the full
 * leaf set. The scanner caches the leaf set pre-event so this is mostly used
 * by web verifiers (ticket page, dashboard).
 */
export interface MerkleProofV1 {
  edition: number;
  /** 0x-prefixed bytes32 — the leaf hash for this edition. */
  leaf: Bytes32Hex;
  /** Sibling hashes from leaf up to root, each 0x-prefixed bytes32. */
  proof: Bytes32Hex[];
}
