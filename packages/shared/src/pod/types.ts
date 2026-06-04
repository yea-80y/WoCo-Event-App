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

import type { Hex64, Hex0x } from "../types.js";

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

// ===========================================================================
// POD layer — kinds, display metadata, creator directory (Step 4, 2026-06-03)
//
// A POD *type* is a manifest. Its cryptographic surface (ManifestV1Body) is
// LOCKED and untouched here. Everything in this section is the MUTABLE,
// creator-facing classification + display layer that lives in the directory
// entry — so re-categorising or renaming a POD never requires re-signing the
// manifest. See docs/WOCO_SHOP_PLAN.md §4.
// ===========================================================================

/**
 * What a POD is *for*. A directory-level classification only — it is NOT bound
 * into the signed manifest (gating keys on a specific `manifestRef`, never on
 * kind). Drives grouping/affordances in the creator POD manager.
 * - `ticket`        — event admission (today's flow).
 * - `badge`         — loyalty/achievement, issued at a milestone. Soulbound.
 * - `collectible`   — drop / first-N / memento. Soulbound (opt-in NFT mirror later).
 * - `authenticity`  — provenance for a physical good. TRANSFERABLE — STUB this
 *                     stage; the transfer mechanism (ERC-721 ownership) is a
 *                     separate product bet, deliberately unbuilt (§4.2/§4.6).
 */
export type PodKind = "ticket" | "badge" | "collectible" | "authenticity";

/**
 * Conventional shape of a POD's free-form `metadata` for DISPLAY. The POD body
 * keeps `metadata: Record<string, unknown>` (no schema change); this interface
 * documents the keys the manager + pickers read so producers populate them
 * consistently. Tickets begin writing `image` = the event image hash so every
 * POD type has a visual in the manager.
 */
export interface PodDisplayMetadata {
  /** Human-readable POD-type name (e.g. "Festival Regular"). */
  name?: string;
  /** Primary artwork — Swarm content ref (no 0x prefix). */
  image?: Hex64;
  description?: string;
  /** Allow extra producer-defined keys without losing the typed ones above. */
  [key: string]: unknown;
}

/**
 * A grouping a creator defines to organise their POD types (e.g. "Loyalty",
 * "Limited drops"). Same shape as the shop's `ProductCategory` by design —
 * one taxonomy concept across the platform, no new model.
 */
export interface PodCategory {
  /** Stable slug/ULID — survives renames, referenced as a POD's `categoryId`. */
  id: string;
  label: string;
  /** Display order; lower first. */
  sortIndex: number;
}

/**
 * Compact entry in a creator's POD directory — one per POD type (manifest).
 * Carries the mutable classification/display layer keyed to the immutable
 * `manifestRef`. Mirrors `SiteDirectoryEntry` / `ShopDirectoryEntry`.
 */
export interface PodDirectoryEntry {
  /** 0x-prefixed bytes32 — the on-chain/manifest commitment. Stable identity. */
  manifestRef: Bytes32Hex;
  kind: PodKind;
  /** Display name (snapshot of the manifest's podTemplate name / metadata name). */
  name: string;
  /** Primary artwork (Swarm ref, no 0x). Event image hash for `ticket` PODs. */
  image?: Hex64;
  description?: string;
  /** Creator-local grouping; references a `PodCategory.id`. */
  categoryId?: string;
  /** Total editions the manifest commits to. */
  supply: number;
  /** How many editions have been issued/claimed so far (best-effort counter). */
  issuedCount?: number;
  /** ed25519 issuer pubkey (hex, lowercase, no 0x) — mirrors the manifest.
   *  Optional: not needed for the manager/holdings/gating; populated only where
   *  a use (e.g. verifying off-event badges) requires it. */
  issuer?: Hex32;
  /** On-chain eventId (0x bytes32) the manifest is committed under — the
   *  holdings reader needs this to read slot ownership. Present once on-chain
   *  registration confirms; for `ticket` PODs that is `confirmSeriesOnChain`. */
  eventId?: Bytes32Hex;
  /** Chain the POD was registered on — the holdings reader / gate config needs
   *  it to read slot ownership. Set alongside `eventId` at on-chain confirm. */
  chainId?: number;
  /** Swarm ref to the `SeriesManifestBlob` (signed manifest + pod-body refs).
   *  Immutable/content-addressed — NOT display layer. Present for PODs minted
   *  through standalone issuance (badge/collectible); the issuance-to-holder /
   *  verification path needs it to fetch the pod bodies + Merkle proofs. Ticket
   *  PODs keep this on the event's `SeriesSummary` instead. */
  swarmManifestRef?: Hex64;
  createdAt: string;
  updatedAt: string;
}

/** Paged on-feed directory of a creator's POD types at `woco/pod/creator/{ethAddress}`. */
export interface PodDirectory {
  v: 1;
  owner: Hex0x;
  pods: PodDirectoryEntry[];
  /** Creator-defined groupings (page 0 only). */
  categories: PodCategory[];
  updatedAt: string;
  /** Number of overflow pages (1..N) beyond page 0. Page 0 only. */
  pages?: number;
}

// ---------------------------------------------------------------------------
// Holdings — the one new shared primitive that powers gating + milestones
// ---------------------------------------------------------------------------

/**
 * A holder's stake in a single POD type, as read from the TRUSTLESS on-chain
 * source (`WoCoEventV2` slot ownership) — NOT the platform-written collection
 * feed, which is spoofable and would undercut the gate (§4.4). `count` is what
 * most gates compare against; `slots` are the specific owned slot indices.
 *
 * Slot indices are **0-based and allocation-order** (the order buyers claimed),
 * so `slot < N` expresses "one of the first N buyers" — the drop / first-N gate
 * falls out for free. Email-only (no-wallet) claims aren't on-chain and so are
 * not gateable by address, which is correct: you can only gate a wallet.
 */
export interface PodHolding {
  manifestRef: Bytes32Hex;
  count: number;
  /** Owned on-chain slot indices (0-based, allocation order). */
  slots: number[];
}

/**
 * A gate rule: hold ≥`minCount` of `manifestRef`, optionally only within a slot
 * range / set, optionally only within a time window. Evaluated by the pure
 * `evaluatePodGate` against a `PodHolding` at claim/order time (v1, server-side)
 * — see §4.3/§4.4. Reused by event gating, product gating, milestone eligibility.
 */
export interface PodGateRule {
  manifestRef: Bytes32Hex;
  /** Minimum holdings to pass. Default 1. */
  minCount?: number;
  /**
   * "First-N" gate: only slots with index < this count toward `minCount`
   * (slots are allocation-order, so this is "first N buyers"). Omit = any slot.
   */
  maxSlotExclusive?: number;
  /** Unix ms — rule does not pass before this (time-limited access). */
  notBefore?: number;
  /** Unix ms — rule does not pass after this (time-limited access). */
  notAfter?: number;
}

/**
 * A STORED, resolved POD gate attached to a ticket series or product. It is a
 * `PodGateRule` (all those fields) PLUS the two read-coordinates the server
 * needs to perform the trustless holdings read (`getOnChainHolding`):
 * `onChainEventId` + `chainId`. There is no global `manifestRef → eventId`
 * index, so the creator snapshots them from the chosen POD's directory entry at
 * config time. Because it is a structural superset of `PodGateRule`, a `PodGate`
 * passes directly to `evaluatePodGate` (the extra fields are ignored).
 *
 * `podName` is a display snapshot for the config UI and the gate-failure message
 * — never authoritative (the cryptographic identity is `manifestRef`).
 */
export interface PodGate {
  manifestRef: Bytes32Hex;
  /** On-chain eventId committing `manifestRef` — needed to read slot ownership. */
  onChainEventId: Bytes32Hex;
  /** Chain the gating POD lives on (holdings read target). */
  chainId: number;
  /** Display name of the gating POD at config time (UI + error text only). */
  podName?: string;
  /** Minimum holdings to pass. Default 1. */
  minCount?: number;
  /** "First-N" gate: only slots with index < this count. Omit = any slot. */
  maxSlotExclusive?: number;
  /** Unix ms — gate closed before this. */
  notBefore?: number;
  /** Unix ms — gate closed after this. */
  notAfter?: number;
}

/**
 * Time / slot window for a `PodGateGroup`. Phase 1 ships `always` + `time`;
 * `firstN` and `reserved` are defined here for schema completeness but not yet
 * enforced (Phase 2 — needs claim-count reads; see docs/WOCO_SHOP_PLAN.md §4).
 */
export type GateWindow =
  | { kind: "always" }
  | { kind: "time"; notBefore?: number; notAfter?: number }
  | { kind: "firstN"; n: number }
  | { kind: "reserved"; reserved: number };

/**
 * Multi-POD gate group. Organiser chooses ANY (hold at least one of the listed
 * PODs) or ALL (hold every listed POD). An optional group-level `window` further
 * restricts when the gate is active. Supersedes a bare `PodGate` stored on a
 * series or product — use `normalizeGate()` to upcast old single-gate records.
 */
export interface PodGateGroup {
  mode: "any" | "all";
  gates: PodGate[];
  window?: GateWindow;
}
