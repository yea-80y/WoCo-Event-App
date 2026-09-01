/**
 * `woco.edition.v1` / `woco.manifest.v2` — the v2 issuance formats
 * (issuer-curve migration PR 3; design record: HANDOVER-pod-curve-migration.md).
 *
 * What changed from `woco.ticket.v2` / `woco.manifest.v1`, and only this:
 *  - the issuer identity is a 20-byte secp256k1 ADDRESS (`IssuerAddress`),
 *    signed EIP-191 personal_sign by the derived issuing key
 *    (`crypto/issuing.ts`) — no ed25519 anywhere on the issuer side;
 *  - `eventId` is GONE from both bodies (#443): it never matched the on-chain
 *    eventId, could not join a manifest to its registration, and had zero
 *    production readers. The chain binding is `manifestRef` alone;
 *  - validation is CLOSED-SCHEMA and refusing (the pod-cert discipline):
 *    unknown fields, non-canonical hex and non-JSON-safe metadata are
 *    rejected at the boundary, never normalised;
 *  - "edition" replaces "POD"/"ticket" as the body noun — one shape serves
 *    both the ticket rail and standalone badge/collectible issuance.
 *
 * What did NOT change — the cryptographic surface underneath: DAG-CBOR
 * deterministic encoding, `keccak256(dagCbor(body))` as the manifest digest
 * (what the chain stores as `manifestRef`), the leaf recipe
 * `keccak256(0x00 || u32be(edition) || dagCbor(body))`, and OZ's
 * `SimpleMerkleTree` scheme. The anchor-equality seams compare digests only,
 * so they need no changes (#444).
 *
 * Old formats are REFUSED, not branched: every verifier here dispatches on
 * `format` first, and `woco.manifest.v1` / `woco.ticket.v2` objects fail that
 * dispatch. Pre-launch, nothing to migrate.
 */

import { isIssuerAddress, type IssuerAddress } from "../crypto/brands.js";
import { isJsonSafeStatementValue } from "../statement/discipline.js";
import type { Bytes32Hex } from "../pod/types.js";
import type { Hex0x } from "../types.js";

export const EDITION_FORMAT = "woco.edition.v1" as const;
export const MANIFEST_V2_FORMAT = "woco.manifest.v2" as const;

/**
 * One edition's body — pre-signed at issuance as a Merkle-tree batch under a
 * single `woco.manifest.v2`. No per-edition signature: the manifest signs the
 * Merkle root of all leaves, and each leaf binds the edition number to the
 * canonical CBOR encoding of this body.
 */
export interface EditionV1Body {
  format: typeof EDITION_FORMAT;
  seriesId: string;
  /** 1-indexed edition number (1..totalSupply). Bound into the leaf hash. */
  edition: number;
  /** Free-form display metadata (name, image, description…). JSON-safe only —
   *  floats, null and non-plain objects are refused so the DAG-CBOR encoding
   *  under the manifest signature survives every JSON round trip. */
  metadata: Record<string, unknown>;
  /** The issuing ADDRESS (0x + 40 lowercase hex). Mirrors the manifest. */
  issuer: IssuerAddress;
}

/**
 * `woco.manifest.v2` body. The signed payload is
 * `keccak256(dagCbor(this body))` (32 bytes) — the same digest the chain
 * stores as `manifestRef`, binding the signature to the on-chain commitment.
 */
export interface ManifestV2Body {
  format: typeof MANIFEST_V2_FORMAT;
  totalSupply: number;
  /** The issuing ADDRESS — verification recovers the personal-sign signer and
   *  compares against this field. */
  issuer: IssuerAddress;
  /** 0x-prefixed lowercase bytes32 — Merkle root over all edition leaves. */
  metadataRoot: Bytes32Hex;
  /** Locked encoder identifier — unchanged from v1. */
  encoding: "cbor-v1";
  /** Locked tree-scheme identifier — unchanged from v1 (`@openzeppelin/merkle-tree`
   *  `SimpleMerkleTree`: leaves verbatim, internal nodes keccak256(sort(L, R))). */
  treeScheme: "oz-simple-v1";
  /** Optional shared metadata template — purely informational; each edition's
   *  own `metadata` is what the Merkle proof commits to. JSON-safe only. */
  editionTemplate?: Record<string, unknown>;
}

/**
 * Signed manifest envelope — what gets uploaded to Swarm. `signature` is
 * EIP-191 personal_sign (r||s||v, 65 bytes, 0x hex) over the ASCII message
 * `woco-manifest-v2\n{0x + digest hex}` — see `canonical.ts`. The signature is
 * NOT in the signed bytes.
 */
export interface SignedManifestV2 {
  body: ManifestV2Body;
  signature: Hex0x;
}

/**
 * Per-edition Merkle proof — carried alongside an edition body when a verifier
 * needs membership in `metadataRoot` without the full leaf set.
 */
export interface EditionProofV1 {
  edition: number;
  /** 0x-prefixed bytes32 — the leaf hash for this edition. */
  leaf: Bytes32Hex;
  /** Sibling hashes from leaf up to root, each 0x-prefixed bytes32. */
  proof: Bytes32Hex[];
}

// ---------------------------------------------------------------------------
// Closed-schema validation — refuse, never normalise
// ---------------------------------------------------------------------------

const BYTES32_RE = /^0x[0-9a-f]{64}$/;
const PERSONAL_SIG_RE = /^0x[0-9a-f]{130}$/;
/** Editions are bound into leaves as u32be — the format's hard ceiling. */
const MAX_EDITION = 0xffffffff;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  o: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  const keys = Object.keys(o);
  return (
    required.every((k) => k in o) &&
    keys.every((k) => required.includes(k) || (optional.includes(k) && o[k] !== undefined))
  );
}

/** Closed-schema validation of an edition body. Dispatch is inside: any other
 *  `format` — including `woco.ticket.v2` — fails here, whole. */
export function validateEditionV1Body(value: unknown): value is EditionV1Body {
  if (!isPlainObject(value)) return false;
  const o = value;
  if (!hasExactKeys(o, ["format", "seriesId", "edition", "metadata", "issuer"])) return false;
  if (o.format !== EDITION_FORMAT) return false;
  if (typeof o.seriesId !== "string" || o.seriesId.length === 0) return false;
  if (!Number.isInteger(o.edition) || (o.edition as number) < 1 || (o.edition as number) > MAX_EDITION) {
    return false;
  }
  if (!isPlainObject(o.metadata) || !isJsonSafeStatementValue(o.metadata)) return false;
  if (!isIssuerAddress(o.issuer)) return false;
  return true;
}

/** Closed-schema validation of a manifest body. Same dispatch rule:
 *  `woco.manifest.v1` fails here, whole — that refusal IS the v1 cutoff. */
export function validateManifestV2Body(value: unknown): value is ManifestV2Body {
  if (!isPlainObject(value)) return false;
  const o = value;
  if (
    !hasExactKeys(
      o,
      ["format", "totalSupply", "issuer", "metadataRoot", "encoding", "treeScheme"],
      ["editionTemplate"],
    )
  ) {
    return false;
  }
  if (o.format !== MANIFEST_V2_FORMAT) return false;
  if (
    !Number.isInteger(o.totalSupply) ||
    (o.totalSupply as number) < 1 ||
    (o.totalSupply as number) > MAX_EDITION
  ) {
    return false;
  }
  if (!isIssuerAddress(o.issuer)) return false;
  if (typeof o.metadataRoot !== "string" || !BYTES32_RE.test(o.metadataRoot)) return false;
  if (o.encoding !== "cbor-v1") return false;
  if (o.treeScheme !== "oz-simple-v1") return false;
  if ("editionTemplate" in o) {
    if (!isPlainObject(o.editionTemplate) || !isJsonSafeStatementValue(o.editionTemplate)) {
      return false;
    }
  }
  return true;
}

/** Closed-schema validation of a signed manifest envelope (shape only — see
 *  `merkle.ts` `verifyManifestV2` for shape + signature). */
export function validateSignedManifestV2(value: unknown): value is SignedManifestV2 {
  if (!isPlainObject(value)) return false;
  const o = value;
  if (!hasExactKeys(o, ["body", "signature"])) return false;
  if (typeof o.signature !== "string" || !PERSONAL_SIG_RE.test(o.signature)) return false;
  return validateManifestV2Body(o.body);
}

/**
 * Rebuild a validated body as a fresh literal in fixed key order — defence
 * against caller objects carrying own-keys via a cast, and mechanical
 * enforcement of omitted-not-undefined for the optional template. dag-cbor
 * sorts map keys itself, so this is not needed for digest determinism.
 */
export function canonicalEditionV1Body(body: EditionV1Body): EditionV1Body {
  return {
    format: body.format,
    seriesId: body.seriesId,
    edition: body.edition,
    metadata: body.metadata,
    issuer: body.issuer,
  };
}

export function canonicalManifestV2Body(body: ManifestV2Body): ManifestV2Body {
  return {
    format: body.format,
    totalSupply: body.totalSupply,
    issuer: body.issuer,
    metadataRoot: body.metadataRoot,
    encoding: body.encoding,
    treeScheme: body.treeScheme,
    ...(body.editionTemplate !== undefined ? { editionTemplate: body.editionTemplate } : {}),
  };
}
