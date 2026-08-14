/**
 * The FROZEN statement discipline (P0, 2026-08-14) shared by every Swarm-native
 * statement type — credits, likes, follows, and future forum types.
 * docs/COASTER_CREDITS_PLAN.md "FROZEN AT P0" is the design record; this file
 * is normative. Statements signed and addressed under these rules live forever
 * at computed addresses, so changing any constant or derivation here is a
 * format bump (a NEW type/version), never an edit.
 *
 * Why a shared DISCIPLINE instead of a shared envelope: per-type payloads
 * differ in stakes. A credit eventually feeds gates, so it carries an identity
 * signature (`holderSig`); a like's author IS its feed owner, so the SOC
 * signature already binds authorship and an extra signature would be surface
 * without a guarantee. What must never differ per type — signing domains, the
 * digest recipe, the topic scheme, the schema rules — lives here.
 */

import * as dagCbor from "@ipld/dag-cbor";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { Hex0x } from "../types.js";

// ---------------------------------------------------------------------------
// Type names and the signing-prefix registry
// ---------------------------------------------------------------------------

/**
 * Statement type names are `[a-z0-9-]+` — a newline can never occur, so the
 * prefix's trailing `-v{n}\n` parse is unambiguous and no two (type, version)
 * pairs share a prefix string.
 */
const STATEMENT_TYPE_RE = /^[a-z0-9-]+$/;

function assertStatementType(type: string): void {
  if (!STATEMENT_TYPE_RE.test(type)) {
    throw new Error(`invalid statement type ${JSON.stringify(type)}: must match [a-z0-9-]+`);
  }
}

function assertVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`invalid statement version: ${version}`);
  }
}

/**
 * The signing domain prefix for an identity-signed statement type:
 * `"woco-{type}-v{n}\n"`. Deliberately distinct in shape from `format` ids,
 * which are dotted (`woco.credit.v1`) — a prefix can never be mistaken for a
 * format id or vice versa.
 */
export function statementSigningPrefix(type: string, version: number): string {
  assertStatementType(type);
  assertVersion(version);
  return `woco-${type}-v${version}\n`;
}

/**
 * The registry: every identity-signed statement format claims its signing
 * prefix here, or it does not sign. Storage-key-only types (likes, follows,
 * subject indexes) have NO entry — they carry no identity signature by design
 * (stakes-driven tiering).
 */
export const STATEMENT_SIGNING_PREFIXES = Object.freeze({
  "woco.credit.v1": statementSigningPrefix("credit", 1),
} as const);

// ---------------------------------------------------------------------------
// Digest recipe
// ---------------------------------------------------------------------------

/**
 * The identity-signature digest: `keccak256(utf8(prefix) || dagCbor(unsigned))`,
 * encoder locked to the same deterministic DAG-CBOR as `pod/canonical.ts`.
 *
 * RULE (frozen): the holder key NEVER signs an externally supplied digest.
 * Every protocol hands structured bytes to a signer that hashes them itself
 * under its own registry prefix — which is why this function takes an object,
 * not bytes, and why no API in this package accepts a caller-computed digest.
 *
 * Cross-protocol safety with the same account's POD-manifest signatures
 * (`pod/merkle.ts` signs `keccak256(dagCbor(body))`, no prefix): the digest
 * PREIMAGES can never be equal, because a canonical manifest encodes as a CBOR
 * map (first byte 0xa0-0xbb) while these bytes start 0x77 ("w").
 */
export function statementSigningDigest(prefix: string, unsigned: object): Uint8Array {
  if (!/^woco-[a-z0-9-]+-v[0-9]+\n$/.test(prefix)) {
    throw new Error(`unregistered signing-prefix shape: ${JSON.stringify(prefix)}`);
  }
  return keccak_256(concatBytes(utf8ToBytes(prefix), dagCbor.encode(unsigned)));
}

// ---------------------------------------------------------------------------
// JSON-safe wire form
// ---------------------------------------------------------------------------

/**
 * Statements travel as JSON: `assembleContentFeed` (swarm/soc.ts) JSON-parses
 * the base payload to detect the multi-chunk manifest, and a non-JSON payload
 * has NO paging path. So every frozen schema must survive a JSON round-trip
 * into the same canonical object: strings, booleans, safe integers, arrays,
 * plain objects. No byte strings, no floats, no null — absent means OMITTED.
 * (Floats are banned outright rather than risked: a whole-number float loses
 * its floatness across JSON and would change the CBOR encoding under the
 * signature.) Per-type validators are closed, which also guarantees no
 * statement can carry the paging manifest's `_woco_mc` marker key.
 */
export function isJsonSafeStatementValue(value: unknown): boolean {
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.every(isJsonSafeStatementValue);
  if (value !== null && typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      return false;
    }
    return Object.values(value as Record<string, unknown>).every(isJsonSafeStatementValue);
  }
  return false; // null, undefined, bigint, function, symbol, non-plain objects
}

// ---------------------------------------------------------------------------
// Topic scheme
// ---------------------------------------------------------------------------

/** HMAC message for a subject-index topic. Frozen. */
export const SUBJECT_INDEX_LABEL = "subject-index";

/**
 * The salt every PUBLIC statement type pins: `utf8("woco-{type}-public-v{n}")`.
 * A fixed public constant — anyone can derive public addresses, which is the
 * point: public statements must be enumerable by any indexer.
 */
export function publicTopicSalt(type: string, version: number): Uint8Array {
  assertStatementType(type);
  assertVersion(version);
  return utf8ToBytes(`woco-${type}-public-v${version}`);
}

/**
 * The per-user PRIVATE salt:
 * `HMAC-SHA256(encryptionPrivKey, utf8("woco-{type}-topic-salt-v{n}"))`.
 * `encryptionPrivKey` is the X25519 key from `deriveEncryptionKeypairFromPodSeed`
 * — deterministic on any device, never transmitted. Knowing a rider's
 * feed-owner address is NOT enough to compute their private topics: presence
 * at a deterministic address is the leak encryption alone cannot close.
 */
export function privateTopicSalt(encryptionPrivKey: Uint8Array, type: string, version: number): Uint8Array {
  assertStatementType(type);
  assertVersion(version);
  if (encryptionPrivKey.length !== 32) {
    throw new Error(`encryption private key must be 32 bytes, got ${encryptionPrivKey.length}`);
  }
  return hmac(sha256, encryptionPrivKey, utf8ToBytes(`woco-${type}-topic-salt-v${version}`));
}

function assertSubjectBytes(subject: Uint8Array): void {
  if (subject.length !== 32) {
    throw new Error(`subject must be 32 bytes, got ${subject.length}`);
  }
}

/** Decode a 0x-prefixed lowercase bytes32 subject to raw bytes (the HMAC message form). */
export function subjectToBytes(subject: Hex0x): Uint8Array {
  if (!/^0x[0-9a-f]{64}$/.test(subject)) {
    throw new Error(`subject must be 0x-prefixed lowercase bytes32 hex`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(subject.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

/**
 * The statement head topic for one (holder, subject):
 * `"woco/{type}/v{n}/" + hex(HMAC-SHA256(salt, subjectBytes))`.
 *
 * Pinned encodings (the freeze exists to kill this ambiguity class): the HMAC
 * message is the RAW 32 subject bytes, never hex text; the suffix is lowercase
 * hex, no 0x. The holder is implicit — topics resolve inside the feed OWNER's
 * address space (`chunk address = keccak256(identifier || owner)`), so the
 * same topic string names a different chunk per owner.
 *
 * ONE LIVE HEAD per (holder, subject): opt-in republishes at the public-salt
 * topic and RETIRES the private head (a one-way migration, never a fork).
 * `seq` continues across the migration; SOC versions restart at 0 at the new
 * topic. Which head is live is recorded by which index partition holds the
 * subject — see {@link subjectIndexTopic}.
 */
export function statementTopic(type: string, version: number, salt: Uint8Array, subject: Uint8Array): string {
  assertStatementType(type);
  assertVersion(version);
  assertSubjectBytes(subject);
  return `woco/${type}/v${version}/${bytesToHex(hmac(sha256, salt, subject))}`;
}

/**
 * The per-holder subject index topic for a statement type:
 * `"woco/{type}/v{n}/index/" + hex(HMAC-SHA256(salt, utf8("subject-index")))`.
 *
 * PARTITION RULE (frozen): a subject lives in exactly ONE of the two indexes —
 * the private-salt index before opt-in, the public-salt index after — and
 * opt-in moves it. The index is not just discovery hygiene: it is how a fresh
 * device learns which head is live for each subject, and how an indexer
 * enumerates a public rider's subjects without probing candidate topics
 * (an absent-chunk probe is the most expensive read on Swarm).
 */
export function subjectIndexTopic(type: string, version: number, salt: Uint8Array): string {
  assertStatementType(type);
  assertVersion(version);
  return `woco/${type}/v${version}/index/${bytesToHex(hmac(sha256, salt, utf8ToBytes(SUBJECT_INDEX_LABEL)))}`;
}

// ---------------------------------------------------------------------------
// Per-holder subject index — shared shape
// ---------------------------------------------------------------------------

/**
 * The subject index payload, instantiated per type (`woco.credit-index.v1`,
 * `woco.like-index.v1`, ...). Storage-key-signed ONLY — deliberately
 * low-stakes: a forged index can only hide subjects or point at statements
 * whose own signatures will not verify, so an identity signature here would be
 * surface without a guarantee (stakes-driven tiering).
 */
export interface SubjectIndexV1<F extends string> {
  format: F;
  /** Every subject with a live head under THIS index's salt partition. */
  subjects: Hex0x[];
}

/** Closed-schema validator for a {@link SubjectIndexV1} instantiation. */
export function validateSubjectIndexV1<F extends string>(value: unknown, format: F): value is SubjectIndexV1<F> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.length !== 2 || keys[0] !== "format" || keys[1] !== "subjects") return false;
  if (o.format !== format) return false;
  return Array.isArray(o.subjects) && o.subjects.every((s) => typeof s === "string" && /^0x[0-9a-f]{64}$/.test(s));
}

// ---------------------------------------------------------------------------
// Ordering and equivocation
// ---------------------------------------------------------------------------

/**
 * Equivocation tie-break (frozen): two validly-signed statements at the same
 * (holder, subject, seq) resolve to the LOWER canonical digest — lexicographic
 * over the 32 raw digest bytes. Deterministic, so two honest indexers always
 * agree GIVEN THE SAME INGESTED SET; no tie-break can canonicalise the input
 * set, which is what the evidence manifest is for (it makes two indexers'
 * inputs comparable). Indexers FLAG equivocations rather than hide them.
 *
 * A same-version race on ONE feed cannot equivocate at all: a SOC is
 * immutable, the first write at a version wins, and the second is silently
 * discarded (201, old payload kept). The consequence is a CLIENT rule: read
 * back after write, because a "successful" write may not be what landed.
 */
export function compareStatementDigests(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== 32 || b.length !== 32) throw new Error("digests must be 32 bytes");
  for (let i = 0; i < 32; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}
