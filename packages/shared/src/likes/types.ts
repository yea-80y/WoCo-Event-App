/**
 * EAS likes / following (buildathon #4) — single source of truth for the
 * on-chain like primitive shared by client write path and server projection.
 *
 * A "like" is an EAS attestation on Arbitrum Sepolia — NOT an NFT, NOT a POD.
 * It points at a per-entity `subject` (`bytes32`): a brand's sub-ENS namehash
 * (profile) or an event's on-chain eventId (event). The attester is the user's
 * own account address; the like keys to it forever. like = attest, unlike =
 * revoke(uid). Owner association is resolved live from chain, never baked in.
 *
 * See docs/EAS_LIKES_HANDOVER.md.
 */

import type { Hex0x } from "../types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * EAS schema definition string. Registered once against SchemaRegistry with
 * resolver = address(0) and revocable = true. The field order is load-bearing
 * — calldata encoding (client) and decoding (server) both depend on it.
 */
export const LIKE_SCHEMA = "bytes32 subject,uint8 subjectType" as const;

/**
 * Subject kind. The numeric value is the on-chain `uint8 subjectType` — do not
 * renumber; existing attestations encode these integers.
 */
export enum SubjectType {
  Profile = 0, // subject = sub-ENS namehash (brand identity, reputation travels on sale)
  Event = 1, // subject = WoCoEventV2 onChainEventId
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/** The thing being liked. `id` is a `bytes32` (namehash or onChainEventId). */
export interface LikeSubject {
  type: SubjectType;
  id: Hex0x;
}

export type LikeAction = "like" | "unlike";

/**
 * One indexed like, as held in the server projection (`.data/likes-index.json`).
 * `uid` is the EAS attestation UID; needed to `revoke` on unlike.
 */
export interface LikeRecord {
  subject: Hex0x;
  subjectType: SubjectType;
  attester: Hex0x; // lowercase user account address
  uid: Hex0x;
}

/** Aggregate view for a subject, returned by the count endpoint. */
export interface LikeCount {
  subject: Hex0x;
  subjectType: SubjectType;
  count: number; // non-revoked attestations, deduped by attester
  likedByViewer: boolean;
  /** The viewer's own attestation UID when likedByViewer — needed to revoke
   *  (unlike) without client-side bookkeeping. Absent when not liked. */
  viewerUid?: Hex0x;
}

/** A trending entry — top subjects by like count (server projection; Stylus #5 later). */
export interface TrendingSubject {
  subject: Hex0x;
  subjectType: SubjectType;
  count: number;
}

// ---------------------------------------------------------------------------
// Chain constants — Arbitrum Sepolia (421614). RE-VERIFIED on-chain 2026-06-05:
// EAS.getSchemaRegistry() returns the SchemaRegistry address below.
// ---------------------------------------------------------------------------

export const EAS_CHAIN_ID = 421614 as const;

export const EAS_ADDRESS: Hex0x = "0x2521021fc8BF070473E1e1801D3c7B4aB701E1dE";
export const SCHEMA_REGISTRY_ADDRESS: Hex0x = "0x45CB6Fa0870a8Af06796Ac15915619a0f22cd475";

/**
 * Schema UID, deterministic from {schema string, resolver, revocable}.
 * Registered + verified on-chain 2026-06-05 (tx 0xf6480b3c…, block 273934624):
 * SchemaRegistry.getSchema returns resolver=address(0), revocable=true,
 * schema="bytes32 subject,uint8 subjectType". Server reads
 * `process.env.EAS_SCHEMA_UID` first and falls back to this; client imports it
 * directly.
 */
export const EAS_SCHEMA_UID: Hex0x =
  "0x62c5b546e61c567163dcb1af412ddd3b6f3a75dbb0da944e89ca2fbeb01dda64";

// ---------------------------------------------------------------------------
// Stylus LikeAggregator (#5) — trustless trending. Deployed + activated on Arb
// Sepolia 2026-06-11 (tx 0x0b928da0…). PULL model: the contract verifies every
// submitted UID against EAS itself, so submissions are permissionless and reads
// are free view calls — clients can hit any public RPC directly; the server is
// only a convenience keeper/cache. Source: contracts-stylus/like-aggregator.
// ---------------------------------------------------------------------------

export const STYLUS_LIKE_AGGREGATOR_ADDRESS: Hex0x =
  "0x7dbf8d3a58bebb642fa1a478bbffba4675f1ba20";

/**
 * Read/keeper ABI (ethers human-readable). NB: Stylus 0.9 encodes the
 * multi-value `getTrending` return as ONE ABI tuple (extra outer offset), so
 * the fragment MUST declare `tuple(...)` — `returns (bytes32[], uint64[])`
 * fails to decode. Static-only tuples (getSubjectAt) are unaffected.
 */
export const STYLUS_LIKE_AGGREGATOR_ABI = [
  "function record(bytes32 uid) returns (bool)",
  "function recordBatch(bytes32[] uids) returns (uint32)",
  "function getCount(bytes32 subject) view returns (uint64)",
  "function getActiveUid(bytes32 subject, address attester) view returns (bytes32)",
  "function totalSubjects() view returns (uint256)",
  "function getSubjectAt(uint256 index) view returns (bytes32, uint8, uint64)",
  "function getTrending(uint8 subjectType, uint32 limit) view returns (tuple(bytes32[] subjects, uint64[] counts))",
  "event LikeCounted(bytes32 indexed subject, uint8 subjectType, address indexed attester, bytes32 uid, uint64 weight)",
  "event LikeUncounted(bytes32 indexed subject, address indexed attester, bytes32 uid, uint64 weight)",
] as const;
