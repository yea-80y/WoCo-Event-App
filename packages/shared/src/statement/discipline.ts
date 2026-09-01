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
  // Gate B, the POD certificate rail. TWO prefixes because two different keys
  // sign two different objects: the badge issuer signs the certificate, and the
  // holder signs the possession challenge that answers for it. One prefix would
  // let a certificate's bytes be replayed as a challenge answer, or the reverse.
  "woco.pod-cert.v1": statementSigningPrefix("pod-cert", 1),
  "woco.pod-cert-challenge.v1": statementSigningPrefix("pod-cert-challenge", 1),
  // The v2 cert rail (issuer-curve migration PR 3). Same two-prefix rule. The
  // cert's ISSUER signature is secp256k1 personal_sign, but its digest is this
  // same registry recipe — the prefix claim below is what keeps the domain
  // unique; the challenge stays holder-ed25519 over its own prefix.
  "woco.cert.v1": statementSigningPrefix("cert", 1),
  "woco.cert-challenge.v1": statementSigningPrefix("cert-challenge", 1),
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
 * SOC versions per BAND, frozen per type-version (2026-08-19).
 *
 * A statement feed is a sequence of bands rather than one unbounded topic.
 * Head lookup used to walk one SOC version per write — measured at 7925ms and
 * 25 probes on a NINE-lap account, and linear forever after. Banding bounds the
 * in-band scan to this constant regardless of lifetime writes.
 *
 * Changing this reshuffles every address forever, so it is frozen alongside the
 * topic scheme. 64 pins the trade-off: worst cold in-band scan is 32 window
 * round-trips of CHEAP hits, and the subject index grows one version per 64
 * writes rather than one per write.
 */
export const STATEMENT_BAND_SIZE = 64;

/** uint64 BIG-ENDIAN (8 bytes) — the band's pinned encoding in an HMAC message. */
function uint64BE(n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), false);
  return b;
}

function assertBand(band: number): void {
  if (!Number.isSafeInteger(band) || band < 0) {
    throw new Error(`invalid band: ${band} (must be a non-negative safe integer)`);
  }
}

/**
 * THE FULL-BAND INVARIANT (frozen, load-bearing).
 *
 * Version 0 of band `b+1` MUST NOT be written unless version
 * `STATEMENT_BAND_SIZE - 1` of band `b` exists. Three consequences, and every
 * one of them is relied on somewhere:
 *
 * 1. Every band except the current one is exactly FULL, so band count is
 *    `floor(writes / STATEMENT_BAND_SIZE)` and discloses nothing `seq` did not.
 * 2. A reader whose in-band scan ends BELOW the last slot KNOWS it holds the
 *    head, with no further probing.
 * 3. Bands are contiguous from 0, so a band can be DISCOVERED by walking
 *    openers with no carrier at all — which is how the social subject index
 *    (no partition rule, nothing read first) finds its band.
 *
 * This is what makes a stale or absent band hint a COST problem rather than a
 * correctness one.
 *
 * SCOPE, so a third party does not build to it wrongly: the invariant governs
 * only feeds that BAND. A type may instead be PINNED to a constant band —
 * likes and follows are, because latest-wins gives them no growth axis — and a
 * pinned feed simply keeps appending inside its band. For those, "band count
 * derives from write count" does not hold, and they must never be band-walked.
 */
export const LAST_VERSION_IN_BAND = STATEMENT_BAND_SIZE - 1;

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
 * The statement head topic for one (holder, subject, BAND):
 * `"woco/{type}/v{n}/" + hex(HMAC-SHA256(salt, subjectBytes || uint64BE(band)))`.
 *
 * Pinned encodings (the freeze exists to kill this ambiguity class): the HMAC
 * message is the RAW 32 subject bytes followed by the band as uint64 BIG-ENDIAN
 * — never hex text, never a decimal string; the suffix is lowercase hex, no 0x.
 *
 * The band is INSIDE the HMAC rather than a plaintext path segment. It costs
 * nothing (topics are hashed into identifiers anyway) and it means a disclosed
 * private topic never yields its siblings. The band is always present, band 0
 * included — a fixed 40-byte message with no special case, which also makes it
 * disjoint by construction from the pre-banding 32-byte scheme, so no address
 * can collide with one written before this change.
 *
 * See {@link STATEMENT_BAND_SIZE} and {@link LAST_VERSION_IN_BAND} for why
 * bands exist and what a writer must uphold. The holder is implicit — topics resolve inside the feed OWNER's
 * address space (`chunk address = keccak256(identifier || owner)`), so the
 * same topic string names a different chunk per owner.
 *
 * ONE LIVE HEAD per (holder, subject): opt-in republishes at the public-salt
 * topic and RETIRES the private head (a one-way migration, never a fork).
 * `seq` continues across the migration; SOC versions restart at 0 at the new
 * topic. Which head is live is recorded by which index partition holds the
 * subject — see {@link subjectIndexTopic}.
 */
export function statementTopic(
  type: string,
  version: number,
  salt: Uint8Array,
  subject: Uint8Array,
  band: number,
): string {
  assertStatementType(type);
  assertVersion(version);
  assertSubjectBytes(subject);
  assertBand(band);
  const message = concatBytes(subject, uint64BE(band));
  return `woco/${type}/v${version}/${bytesToHex(hmac(sha256, salt, message))}`;
}

/**
 * The per-holder subject index topic for a statement type and BAND:
 * `"woco/{type}/v{n}/index/" + hex(HMAC-SHA256(salt, utf8("subject-index") || uint64BE(band)))`.
 *
 * The index is banded on the same rule as statements, because it grows too: one
 * version per new subject, and subjects are never removed. Social types have no
 * partition rule and so nothing read first to carry a band hint — they discover
 * it by walking openers under the full-band invariant, which needs no carrier.
 *
 * PARTITION RULE (frozen): a subject lives in exactly ONE of the two indexes —
 * the private-salt index before opt-in, the public-salt index after — and
 * opt-in moves it. The index is not just discovery hygiene: it is how a fresh
 * device learns which head is live for each subject, and how an indexer
 * enumerates a public rider's subjects without probing candidate topics
 * (an absent-chunk probe is the most expensive read on Swarm).
 */
export function subjectIndexTopic(type: string, version: number, salt: Uint8Array, band: number): string {
  assertStatementType(type);
  assertVersion(version);
  assertBand(band);
  const message = concatBytes(utf8ToBytes(SUBJECT_INDEX_LABEL), uint64BE(band));
  return `woco/${type}/v${version}/index/${bytesToHex(hmac(sha256, salt, message))}`;
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

/**
 * The V2 subject index payload: each entry carries the subject's CURRENT BAND.
 *
 * V1 was `{ format, subjects: Hex0x[] }` and its validator is CLOSED, so
 * carrying a band is a true format bump rather than an edit. Types whose heads
 * cannot leave band 0 (likes and follows are latest-wins, so their statement
 * feeds hold one version per toggle) stay on V1 — only their index TOPIC moves.
 *
 * `band` is a MONOTONIC LOWER BOUND, exactly like a version hint: the highest
 * band the last writer knew to be open. A stale value costs a short forward
 * walk under the full-band invariant, never correctness. The merge rule after a
 * lost write race is union-of-subjects, per-subject MAX band.
 *
 * Storage-key-signed only, same stakes argument as V1: a forged band can make a
 * reader walk, never make it believe a wrong count.
 */
export interface SubjectIndexV2<F extends string> {
  format: F;
  entries: { subject: Hex0x; band: number }[];
}

/** Closed-schema validator for a {@link SubjectIndexV2} instantiation. */
export function validateSubjectIndexV2<F extends string>(value: unknown, format: F): value is SubjectIndexV2<F> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.length !== 2 || keys[0] !== "entries" || keys[1] !== "format") return false;
  if (o.format !== format) return false;
  if (!Array.isArray(o.entries)) return false;
  return o.entries.every((e) => {
    if (e === null || typeof e !== "object" || Array.isArray(e)) return false;
    const ek = Object.keys(e as Record<string, unknown>).sort();
    if (ek.length !== 2 || ek[0] !== "band" || ek[1] !== "subject") return false;
    const { subject, band } = e as { subject: unknown; band: unknown };
    return (
      typeof subject === "string" &&
      /^0x[0-9a-f]{64}$/.test(subject) &&
      typeof band === "number" &&
      Number.isSafeInteger(band) &&
      band >= 0
    );
  });
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
