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
