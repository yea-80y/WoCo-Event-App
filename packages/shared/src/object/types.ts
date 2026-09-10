/**
 * POD layer — the LIVE display, directory and gating types.
 *
 * The v1 cryptographic surface that used to open this file (`woco.ticket.v2`
 * bodies, `woco.manifest.v1`, the ed25519 issuer) was DELETED in the
 * issuer-curve migration (PR 5a). The live formats are `woco.edition.v1` +
 * `woco.manifest.v2` in `edition/`, signed by the derived secp256k1 issuing
 * key; certificates are `woco.cert.v1` in `cert/`. Nothing here signs or
 * verifies — these are the mutable classification/display records and the
 * gate schema, keyed on `manifestRef` digests.
 */

import type { Hex64, Hex0x } from "../types.js";

/** 0x-prefixed bytes32 hex (66 chars including 0x). */
export type Bytes32Hex = string;

// ===========================================================================
// POD layer — kinds, display metadata, creator directory (Step 4, 2026-06-03)
//
// A POD *type* is a manifest. Its cryptographic surface (`woco.manifest.v2`,
// edition/types.ts) is LOCKED and untouched here. Everything in this section is the MUTABLE,
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
  /** Issuer identity mirror — UNVERIFIED display hint, never a trust input.
   *  v1 entries hold the ed25519 pubkey (bare 64-hex); v2 entries (5a) hold the
   *  20-byte issuing ADDRESS. Optional: not needed for manager/holdings/gating. */
  issuer?: string;
  /** On-chain eventId (0x bytes32) the manifest is committed under — the
   *  holdings reader needs this to read slot ownership. Present once on-chain
   *  registration confirms; for `ticket` PODs that is `confirmSeriesOnChain`. */
  eventId?: Bytes32Hex;
  /** Chain the POD was registered on — the holdings reader / gate config needs
   *  it to read slot ownership. Set alongside `eventId` at on-chain confirm. */
  chainId?: number;
  /**
   * The issuer's CONTENT-FEED owner address, for badges whose holdings are POD
   * certificates — without which the certificate log cannot be found at all.
   *
   * A log's chunk addresses are `keccak256(identifier ‖ owner)`, and while the
   * identifier is derivable from `manifestRef` by anyone, the owner is the
   * issuer's secp256k1 content-feed address, which appears in NO public
   * artifact: the manifest carries only the ed25519 `issuerPubkey`, and no feed
   * publishes the mapping. A supply auditor, a third-party enumerator, and the
   * holder-import path all need (owner, topic).
   *
   * Display layer, mutable, platform-signed — NOT a trust root. It says where to
   * look, and everything found there is verified against the badge's manifest
   * anyway. The CANONICAL binding ("this is my one true log, not one of two I
   * show different auditors") needs an issuer-ed25519-signed statement and
   * belongs to the deferred issuer registry: forgery is already impossible here,
   * since a fake log can only mirror real certificates or carry ones that fail
   * verification. Only split-view equivocation remains, and equivocation is
   * flagged rather than prevented everywhere in this design.
   */
  certLogOwner?: Hex0x;
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
 * A STORED, resolved POD gate attached to a ticket series or product — a
 * DISCRIMINATED UNION over where the holding it checks comes from.
 *
 * Two sources exist (docs/SWARM_SOCIAL_PLAN.md, Gate B): on-chain slot
 * ownership, and issuer-signed POD certificates. Both variants are structural
 * supersets of `PodGateRule`, so either passes directly to `evaluatePodGate` —
 * the evaluator stays source-agnostic and never learned about any of this.
 *
 * WHY A UNION rather than one interface with optional coordinates: the fields
 * that differ are the read-coordinates the enforcement path dereferences on a
 * money-moving route. Under a union the compiler names every site that must
 * branch, and adding a THIRD source later breaks compilation at each dispatch
 * instead of silently adding an optional nobody narrows. The gate type follows
 * the same dispatch-before-validation discipline as the statement formats.
 *
 * READING AN OLD RECORD (the rule, and it is load-bearing): a stored gate with
 * NO `holdingSource` is a CHAIN gate. True historically — every gate written
 * before the field existed passed through `validatePodGate`, which required the
 * chain binding, so no other kind can exist — and safe by direction: chain is
 * the strictest proof, so misreading could only make a gate harder to pass,
 * never let a certificate satisfy chain-configured trust. Present-but-
 * unrecognised must REFUSE, so a future source written by newer code fails
 * closed on an older server rather than falling into the chain arm.
 *
 * `podName` is a display snapshot for the config UI and the gate-failure message
 * — never authoritative (the cryptographic identity is `manifestRef`).
 */
interface PodGateBase {
  manifestRef: Bytes32Hex;
  /** Display name of the gating POD at config time (UI + error text only). */
  podName?: string;
  /** Unix ms — gate closed before this. */
  notBefore?: number;
  /** Unix ms — gate closed after this. */
  notAfter?: number;
}

/**
 * Chain-sourced gate: holdings read from `WoCoEventV2` slot ownership.
 *
 * `holdingSource` is optional HERE AND NOWHERE ELSE — that asymmetry is what
 * makes an absent discriminant narrow to this variant in TypeScript as well as
 * at runtime. New gates should still write it explicitly, so records are
 * self-describing to a third-party reader.
 *
 * There is no global `manifestRef → eventId` index, so the creator snapshots
 * both coordinates from the chosen POD's directory entry at config time, and
 * `validatePodGate` proves on-chain that the event really does commit
 * `manifestRef` before the gate is stored.
 */
export interface ChainPodGate extends PodGateBase {
  holdingSource?: "chain";
  /** On-chain eventId committing `manifestRef` — needed to read slot ownership. */
  onChainEventId: Bytes32Hex;
  /** Chain the gating POD lives on (holdings read target). */
  chainId: number;
  /** Minimum holdings to pass. Default 1. */
  minCount?: number;
  /** "First-N" gate: only slots with index < this count. Omit = any slot. */
  maxSlotExclusive?: number;
}

/**
 * Certificate-sourced gate: holdings derived from an issuer-signed
 * `woco.pod-cert.v1` plus a possession challenge the holder answers. No chain
 * coordinates, because there is no chain read.
 *
 * NOTE WHAT IS ABSENT: there is no `issuerPubkey`. Storing one would create
 * exactly the object the rail is built to avoid — an issuer key bound to the
 * badge by nothing, against which a forged certificate verifies perfectly while
 * the UI shows the real badge's artwork. The key is re-derived from the manifest
 * at every enforcement instead, which costs one cacheable content-addressed
 * fetch and cannot be wrong, because the cache is keyed by the digest that binds
 * it. Nor can the key go stale: it is baked into the manifest, so a different
 * key is a different `manifestRef` and therefore a different badge.
 *
 * `maxSlotExclusive` is absent because slots are the chain model's; `minCount`
 * admits only 1 because a certificate holding is presence, not quantity.
 */
export interface CertPodGate extends PodGateBase {
  holdingSource: "pod-cert";
  /**
   * Swarm ref (no 0x) of the `SeriesManifestBlob` carrying this badge's signed
   * manifest. A LOCATION HINT, not a trust root: enforcement recomputes
   * `keccak256(dagCbor(body))` and requires it to equal `manifestRef`, so a
   * wrong ref fails closed rather than shifting trust to whoever wrote it.
   * The safer analogue of the chain variant's snapshotted `onChainEventId`.
   */
  swarmManifestRef: Hex64;
  /** Presence, not quantity — 1 is the only minimum this source can express. */
  minCount?: 1;
}

export type PodGate = ChainPodGate | CertPodGate;

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
