/**
 * `woco.credit.v1` — FROZEN at P0 (2026-08-14). docs/COASTER_CREDITS_PLAN.md
 * "FROZEN AT P0" is the design record. The schema is CLOSED: any added field,
 * at any nesting level, is `woco.credit.v2`. Rider feeds are write-once and
 * public, so a schema mistake here is inherited by every future credit —
 * which is why this file is types + pure derivations only, no machinery.
 *
 * Rides the statement discipline (`../statement/discipline.ts`) with the
 * credit-specific piece on top: an identity signature. The SOC signature only
 * proves who wrote the FEED; without `holderSig` anyone could write a
 * statement into their own feed naming someone else's `holder`, and an
 * indexer keying counts by holder would have no basis to reject it.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { Hex0x } from "../types.js";
import {
  STATEMENT_SIGNING_PREFIXES,
  publicTopicSalt,
  privateTopicSalt,
  statementSigningDigest,
  statementTopic,
  subjectIndexTopic,
  subjectToBytes,
  validateSubjectIndexV2,
  type SubjectIndexV2,
} from "../statement/discipline.js";

// ---------------------------------------------------------------------------
// Formats and constants
// ---------------------------------------------------------------------------

export const CREDIT_STATEMENT_FORMAT = "woco.credit.v1" as const;
/**
 * BUMPED from `woco.credit-index.v1` (2026-08-19). V1 was `{ format, subjects[] }`
 * with a CLOSED validator, so carrying the per-subject band is a true format bump,
 * not an edit. The band is what makes head lookup O(1): the partition rule already
 * forces every read to fetch this index first, so the band rides along free.
 */
export const CREDIT_SUBJECT_INDEX_FORMAT = "woco.credit-index.v2" as const;

/** Registry prefix for the holderSig digest — `"woco-credit-v1\n"`. */
export const CREDIT_SIGNING_PREFIX: string = STATEMENT_SIGNING_PREFIXES[CREDIT_STATEMENT_FORMAT];

/** Discipline (type, version) the topic scheme derives from. */
const CREDIT_TYPE = "credit";
const CREDIT_VERSION = 1;

/**
 * Subject-hash domain. The id hashed under it is a WoCo-minted opaque ULID —
 * NEVER an external id (RCDB etc.), which are mutable aliases in the subject
 * registry. This is the recorded exception to SWARM_SOCIAL_PLAN commitment 2:
 * a coaster is not a sovereign identity, and aliases restore interop.
 */
export const CREDIT_SUBJECT_DOMAIN = "woco:coaster:v1:" as const;

// ---------------------------------------------------------------------------
// The statement
// ---------------------------------------------------------------------------

/** The current day's block. As CLOSED as the top level — exact field set only. */
export interface CreditSessionV1 {
  /** UTC calendar date, YYYY-MM-DD. UTC so the signed field never depends on
   *  the (mutable) subject registry; display localises through the registry
   *  timezone. At a UTC-8 park every day splits mid-afternoon — accepted. */
  date: string;
  count: number;
  /** Evidence MATERIALS only — the tier is computed by the indexer, never
   *  declared. Opaque `"{formatId}:{base64url}"` strings (base64url unpadded):
   *  the closed v1 schema pins the FIELD while the token format inside the
   *  string versions independently (pinned at P3). Strings, not bytes,
   *  because the wire form is JSON (paging depends on it); absent at v1. */
  exitTokens?: string[];
}

/**
 * One CURRENT statement per (holder, subject) — the head carries the lifetime
 * total plus today's block; older days are recovered by walking SOC versions.
 * There is deliberately NO `evidence` field (computed, never declared), NO
 * `firstAt`/`lastAt` (self-declared times are false confidence, and per-ride
 * times are a routine profile of a minor-heavy audience), NO `nonce` (`seq`
 * subsumes replay dedup and adds ordering), and NO `prevSession` (derivable
 * from the SOC version sequence — frozen surface for a computable value).
 */
export interface CreditStatementV1 {
  format: typeof CREDIT_STATEMENT_FORMAT;
  /** keccak256(CREDIT_SUBJECT_DOMAIN + ulid), 0x-prefixed lowercase. */
  subject: Hex0x;
  /** Rider's ed25519 POD public key (hex, no 0x) — the owner-of-record, the
   *  same identity as `ClaimedTicket.owner`. Chosen over the feed key for
   *  key-exposure containment: the feed signer is deliberately low-stakes,
   *  escrowed, and effectively unrotatable. */
  holder: string;
  /** Monotonic per (holder, subject); latest = highest seq — THE ordering
   *  authority. Continues across the private→public topic migration. */
  seq: number;
  /** Lifetime rides for this subject. Carried, never summed across writes. */
  total: number;
  session: CreditSessionV1;
  /** ed25519 by `holder` (hex, no 0x) over the discipline digest:
   *  keccak256("woco-credit-v1\n" || dagCbor(statement minus holderSig)). */
  holderSig: string;
}

export type UnsignedCreditStatementV1 = Omit<CreditStatementV1, "holderSig">;

// ---------------------------------------------------------------------------
// Subject identity and topics
// ---------------------------------------------------------------------------

/** The permanent bytes32 subject for a WoCo-minted coaster id. */
export function creditSubject(stableId: string): Hex0x {
  if (stableId.length === 0) throw new Error("empty subject id");
  return `0x${bytesToHex(keccak_256(utf8ToBytes(CREDIT_SUBJECT_DOMAIN + stableId)))}` as Hex0x;
}

/** The fixed public salt: utf8("woco-credit-public-v1"). */
export function creditPublicSalt(): Uint8Array {
  return publicTopicSalt(CREDIT_TYPE, CREDIT_VERSION);
}

/** The rider's private salt: HMAC(x25519PrivKey, "woco-credit-topic-salt-v1"). */
export function creditPrivateSalt(encryptionPrivKey: Uint8Array): Uint8Array {
  return privateTopicSalt(encryptionPrivKey, CREDIT_TYPE, CREDIT_VERSION);
}

/**
 * Head topic for one (holder, subject, band) under the given salt partition.
 *
 * The band is REQUIRED and never defaulted: a wrong band reads the wrong chapter
 * of a rider's logbook, and on the write path it targets a version that already
 * exists — which Bee dedupes silently. Make every caller state it.
 */
export function creditStatementTopic(salt: Uint8Array, subject: Hex0x, band: number): string {
  return statementTopic(CREDIT_TYPE, CREDIT_VERSION, salt, subjectToBytes(subject), band);
}

/** Per-holder subject index topic for one band, under the given salt partition. */
export function creditSubjectIndexTopic(salt: Uint8Array, band: number): string {
  return subjectIndexTopic(CREDIT_TYPE, CREDIT_VERSION, salt, band);
}

export type CreditSubjectIndexV2 = SubjectIndexV2<typeof CREDIT_SUBJECT_INDEX_FORMAT>;

export function validateCreditSubjectIndexV2(value: unknown): value is CreditSubjectIndexV2 {
  return validateSubjectIndexV2(value, CREDIT_SUBJECT_INDEX_FORMAT);
}

// ---------------------------------------------------------------------------
// Strict validation — the closed-schema rule, made executable
// ---------------------------------------------------------------------------

const SUBJECT_RE = /^0x[0-9a-f]{64}$/;
const ED25519_PUB_RE = /^[0-9a-f]{64}$/;
const ED25519_SIG_RE = /^[0-9a-f]{128}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** formatId ":" base64url (unpadded). formatIds are dotted, like all format ids. */
const EXIT_TOKEN_RE = /^[a-z0-9.-]+:[A-Za-z0-9_-]+$/;

function hasExactKeys(o: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(o);
  return (
    required.every((k) => k in o) &&
    keys.every((k) => required.includes(k) || (optional.includes(k) && o[k] !== undefined))
  );
}

function isCount(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

function validateSession(value: unknown): value is CreditSessionV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  if (!hasExactKeys(s, ["date", "count"], ["exitTokens"])) return false;
  if (typeof s.date !== "string" || !DATE_RE.test(s.date)) return false;
  if (!isCount(s.count)) return false;
  if ("exitTokens" in s) {
    if (!Array.isArray(s.exitTokens)) return false;
    if (!s.exitTokens.every((t) => typeof t === "string" && EXIT_TOKEN_RE.test(t))) return false;
  }
  return true;
}

/**
 * Closed-schema validation of the UNSIGNED shape. Dispatch happens BEFORE
 * this: a reader reads `format` first and applies this validator only for
 * `woco.credit.v1`, so a v2 object fails whole instead of half-parsing.
 * Unknown fields are REJECTED, not ignored; absent optionals are OMITTED,
 * never null (both are what make the DAG-CBOR digest unambiguous).
 */
function validateUnsigned(value: unknown): value is UnsignedCreditStatementV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  if (!hasExactKeys(o, ["format", "subject", "holder", "seq", "total", "session"])) return false;
  if (o.format !== CREDIT_STATEMENT_FORMAT) return false;
  if (typeof o.subject !== "string" || !SUBJECT_RE.test(o.subject)) return false;
  if (typeof o.holder !== "string" || !ED25519_PUB_RE.test(o.holder)) return false;
  if (!isCount(o.seq) || !isCount(o.total)) return false;
  return validateSession(o.session);
}

/** Closed-schema validation of a full signed statement (shape only — see
 *  {@link verifyCreditStatement} for shape + signature). */
export function validateCreditStatementV1(value: unknown): value is CreditStatementV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  if (!hasExactKeys(o, ["format", "subject", "holder", "seq", "total", "session", "holderSig"])) return false;
  if (typeof o.holderSig !== "string" || !ED25519_SIG_RE.test(o.holderSig)) return false;
  const { holderSig: _sig, ...unsigned } = o;
  return validateUnsigned(unsigned);
}

// ---------------------------------------------------------------------------
// Signing and verification
// ---------------------------------------------------------------------------

/**
 * Rebuild the unsigned object as a fresh literal in a FIXED key order before
 * encoding. dag-cbor sorts map keys, so this is not needed for digest
 * determinism — it is defence against a caller's object carrying own-keys the
 * validator would reject arriving here via a cast, and it enforces
 * omitted-not-null for `exitTokens` mechanically.
 */
function canonicalUnsigned(u: UnsignedCreditStatementV1): UnsignedCreditStatementV1 {
  return {
    format: u.format,
    subject: u.subject,
    holder: u.holder,
    seq: u.seq,
    total: u.total,
    session: {
      date: u.session.date,
      count: u.session.count,
      ...(u.session.exitTokens !== undefined ? { exitTokens: [...u.session.exitTokens] } : {}),
    },
  };
}

/** The closure-2 digest for a statement. Throws on an invalid shape — a
 *  digest of an unvalidated object must never exist. */
export function creditStatementDigest(unsigned: UnsignedCreditStatementV1): Uint8Array {
  if (!validateUnsigned(unsigned)) throw new Error("invalid woco.credit.v1 unsigned statement");
  return statementSigningDigest(CREDIT_SIGNING_PREFIX, canonicalUnsigned(unsigned));
}

/** Sign as `holder`. `holderPrivKey` is the rider's 32-byte ed25519 POD
 *  private key; the statement's `holder` MUST be its public key. */
export function signCreditStatement(
  unsigned: UnsignedCreditStatementV1,
  holderPrivKey: Uint8Array,
): CreditStatementV1 {
  const digest = creditStatementDigest(unsigned);
  const pub = bytesToHex(ed25519.getPublicKey(holderPrivKey));
  if (pub !== unsigned.holder) {
    throw new Error("holder key mismatch: statement.holder is not this private key's public key");
  }
  return { ...canonicalUnsigned(unsigned), holderSig: bytesToHex(ed25519.sign(digest, holderPrivKey)) };
}

/**
 * Full acceptance check: format dispatch → closed-schema validation →
 * signature verification, in that order. Returns false on any failure, never
 * throws (mirrors `verifySignedManifest`) — callers branch on a boolean.
 */
export function verifyCreditStatement(value: unknown): value is CreditStatementV1 {
  try {
    if (!validateCreditStatementV1(value)) return false;
    const { holderSig, ...unsigned } = value;
    const digest = statementSigningDigest(CREDIT_SIGNING_PREFIX, canonicalUnsigned(unsigned));
    return ed25519.verify(hexToBytes(holderSig), digest, hexToBytes(value.holder));
  } catch {
    return false;
  }
}
