/**
 * `woco.pod-cert.v1` + `woco.pod-cert-challenge.v1` — the POD CERTIFICATE rail
 * (Gate B). docs/SWARM_SOCIAL_PLAN.md "Gate B is the POD-CERTIFICATE rail" is
 * the design record; this file is normative.
 *
 * Nothing here replaces PODs. The badge stays a POD — its manifest, artwork,
 * `PodKind: "badge"`, its place in the POD directory. What changes is only how
 * HOLDING is recorded: today that is an on-chain slot (`slotOwner[eventId][slot]`,
 * see the note at `pod/types.ts`), and a POD certificate makes it an
 * ISSUER-SIGNED statement that names its holder.
 *
 * Two objects, two signers, and the split is the whole security argument:
 *
 * - the CERTIFICATE is signed by the badge type's issuer (`ManifestV1Body.issuerPubkey`)
 *   and names the holder's ed25519 POD key in the signed body. Born bound — there
 *   is no binding ceremony a copied certificate could race.
 * - the CHALLENGE is signed by that holder key, at the door, over a
 *   verifier-supplied audience and nonce. Copying the certificate bytes is
 *   possible and pointless: every use ends in a challenge only the named key
 *   can answer.
 *
 * THE HARD RULE this rail exists to keep (docs/COASTER_CREDITS_PLAN.md): a
 * rider's SELF-signed credits must never satisfy a `PodGateRule`. It is kept
 * structurally, not by convention — the only route from bytes to a `PodHolding`
 * is `holdings.ts`, which accepts issuer-verified certificates and nothing else.
 * A `woco.credit.v1` object fails format dispatch here and always will.
 *
 * Rides the statement discipline (`../statement/discipline.ts`) unchanged:
 * registry-prefixed digests, closed JSON-safe schemas, dispatch-before-validation,
 * banded topics. Both schemas are CLOSED — any added field, at any nesting level,
 * is a v2. Certificates live forever at computed addresses in an issuer's public
 * log, so a schema mistake here is inherited by every certificate that follows.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { Hex0x } from "../types.js";
import type { Bytes32Hex, Hex32 } from "../pod/types.js";
import {
  STATEMENT_SIGNING_PREFIXES,
  publicTopicSalt,
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

export const POD_CERT_FORMAT = "woco.pod-cert.v1" as const;
export const POD_CERT_CHALLENGE_FORMAT = "woco.pod-cert-challenge.v1" as const;

/**
 * The issuer's index of badge types it has issued certificates for.
 *
 * NAMED `.v1` BUT SHAPED `SubjectIndexV2` — read this before touching it. The
 * `V1`/`V2` in the discipline's interface names version the SHAPE (V2 carries a
 * per-subject band); the `.v1` here versions THIS TYPE's payload, which has
 * never had another version because the type is new. Certificate feeds append
 * one SOC version per issuance and so cross bands, which is exactly why the
 * band-carrying shape is the right one from the start. Validate only through
 * {@link validatePodCertSubjectIndex} — `validateSubjectIndexV1` against this
 * format id would silently accept the wrong shape.
 */
export const POD_CERT_SUBJECT_INDEX_FORMAT = "woco.pod-cert-index.v1" as const;

/** Registry prefix for the `issuerSig` digest — `"woco-pod-cert-v1\n"`. */
export const POD_CERT_SIGNING_PREFIX: string = STATEMENT_SIGNING_PREFIXES[POD_CERT_FORMAT];

/** Registry prefix for the `holderSig` digest — `"woco-pod-cert-challenge-v1\n"`. */
export const POD_CERT_CHALLENGE_SIGNING_PREFIX: string =
  STATEMENT_SIGNING_PREFIXES[POD_CERT_CHALLENGE_FORMAT];

/** Discipline (type, version) the certificate topic scheme derives from. */
const POD_CERT_TYPE = "pod-cert";
const POD_CERT_VERSION = 1;

// ---------------------------------------------------------------------------
// The certificate
// ---------------------------------------------------------------------------

/**
 * An issuer's signed record that `holder` holds badge type `badge`.
 *
 * Deliberately ABSENT, each for a stated reason:
 * - no `issuer` field — computable. `badge` IS `keccak256(dagCbor(manifestBody))`,
 *   so fetching the manifest content-addressably yields `issuerPubkey` with the
 *   binding already proved. Frozen surface for a computable value is the rule
 *   that killed the credit statement's `prevSession`.
 * - no `expiresAt` / `revoked` — an entitlement is a policy applied at a live
 *   door, not a property of the record. An issuer can never un-sign; a disowning
 *   issuer publishes a SECOND signed statement and third parties see both.
 * - no `slot` / `edition` — allocation order is the chain rail's model. A
 *   certificate is presence, not quantity (see `podCertHolding`).
 * - no `seq` — SOC versions order the issuer's log, and a certificate is not
 *   latest-wins state that could need re-ordering after the fact.
 */
export interface PodCertV1 {
  format: typeof POD_CERT_FORMAT;
  /**
   * The badge TYPE's `manifestRef` (0x-prefixed lowercase bytes32) — the same
   * stable identity `PodDirectoryEntry.manifestRef` and `PodGate.manifestRef`
   * key on, joining this record to the POD display layer (artwork,
   * `PodKind: "badge"`, `swarmManifestRef`) with nothing new built.
   */
  badge: Bytes32Hex;
  /**
   * Recipient's ed25519 POD public key (hex, no 0x) — the same identity that
   * owns their tickets (`ClaimedTicket.owner`), and the key that must answer
   * the possession challenge. This field is what makes the certificate
   * soulbound in substance rather than by declaration.
   */
  holder: Hex32;
  /**
   * UTC calendar date, YYYY-MM-DD. SELF-DECLARED and unverifiable — nothing
   * timestamps a Swarm write. Hardened only by the optional per-epoch anchor
   * (docs/SWARM_SOCIAL_PLAN.md, the fourth category); never treat it as proof.
   *
   * Validated SYNTACTICALLY only, deliberately: an impossible-but-shaped date
   * (`2026-02-30`) is accepted here exactly as it is by the frozen credit
   * validator. A stricter rule would make two honest implementations disagree
   * about a garbage value on a field nothing verifies — interop divergence
   * bought at the price of nothing.
   */
  issuedAt: string;
  /**
   * OPTIONAL X25519 public key (hex, no 0x) — the holder's encryption key from
   * `deriveEncryptionKeypairFromPodSeed`, recorded so a publisher enumerating
   * this issuer's log can seal per-drop content to current holders (the HPKE
   * alternative to Swarm ACT for club content).
   *
   * It is here rather than computed because it is NOT computable: the X25519
   * key is HKDF'd from the POD SEED (`crypto/keys.ts`), not converted from
   * `holder`, and no WoCo feed publishes it — `UserProfile` has no key field.
   * Optional because a certificate may be issued for a holder whose encryption
   * key the issuer does not have, and omitting it must stay free.
   */
  encPubKey?: Hex32;
  /**
   * OPTIONAL audit trail: what the issuer read before signing (e.g. the
   * indexer evidence report behind a verified lap count).
   *
   * Opaque `"{formatId}:{base64url}"` strings, the same tagged shape the frozen
   * credit statement pins for `exitTokens` and for the same reason: the closed
   * v1 schema fixes the FIELD while the token format inside the string versions
   * independently. Evidence kinds will multiply; the schema must not have to.
   */
  evidence?: string[];
  /**
   * ed25519 by the badge manifest's `issuerPubkey` (hex, no 0x) over the
   * discipline digest: keccak256("woco-pod-cert-v1\n" || dagCbor(cert minus issuerSig)).
   */
  issuerSig: string;
}

export type UnsignedPodCertV1 = Omit<PodCertV1, "issuerSig">;

/**
 * Ceiling on ONE serialized certificate, enforced at SIGNING.
 *
 * `evidence` is regex-validated per entry but bounded in neither entry length
 * nor count, so a certificate can exceed a whole 4096-byte SOC payload by
 * itself. That matters more than it looks: an oversized certificate pushes its
 * log page onto the multi-chunk paging path, which is a torn-write hazard
 * (issue #315) and destroys the atomicity that makes a write's read-back
 * verification mean anything. Until the holder-import slice exists a
 * certificate lives NOWHERE but that log, so an unverifiable write is a
 * certificate that may not exist.
 *
 * Generous — a conforming certificate with no evidence is ~250 bytes.
 *
 * VERIFICATION DOES NOT APPLY THIS BOUND, deliberately: it is a producer-side
 * guard, and tightening what verifies would retroactively invalidate bytes an
 * issuer has already signed.
 */
export const MAX_POD_CERT_BYTES = 2048;

/** Serialized byte length of a value as it will be written to a feed. */
export function jsonByteLength(value: unknown): number {
  return utf8ToBytes(JSON.stringify(value)).length;
}

// ---------------------------------------------------------------------------
// The possession challenge
// ---------------------------------------------------------------------------

/**
 * The door's question and the holder's answer, in one signed object.
 *
 * Structured bytes under its own registry prefix, per the frozen rule that the
 * holder key NEVER signs an externally supplied digest — the verifier hands over
 * fields, and the signer hashes them itself.
 *
 * `audience` is what stops a challenge answered at one door being replayed at
 * another, and `nonce` is what stops it being replayed at the SAME door. Both
 * are chosen by the verifier; neither is meaningful without the other.
 */
export interface PodCertChallengeV1 {
  format: typeof POD_CERT_CHALLENGE_FORMAT;
  /** Badge type being claimed — must equal the presented certificate's `badge`. */
  badge: Bytes32Hex;
  /** Holder key being challenged — must equal the certificate's `holder`. */
  holder: Hex32;
  /**
   * The verifier's identity: an origin (`https://club.example.com`), a scanner
   * id, whatever the door calls itself. Printable ASCII, no spaces, so it can
   * never be ambiguous about where its own value ends.
   */
  audience: string;
  /** Verifier-chosen, base64url unpadded, ≥16 bytes of entropy (22+ chars). */
  nonce: string;
  /**
   * Unix MILLISECONDS — the same clock unit as `PodGateRule.notBefore/notAfter`,
   * so a door never mixes units between the window check and this one.
   */
  expiresAt: number;
  /**
   * ed25519 by `holder` (hex, no 0x) over the discipline digest:
   * keccak256("woco-pod-cert-challenge-v1\n" || dagCbor(challenge minus holderSig)).
   */
  holderSig: string;
}

export type UnsignedPodCertChallengeV1 = Omit<PodCertChallengeV1, "holderSig">;

// ---------------------------------------------------------------------------
// Topics — the issuer's public log
// ---------------------------------------------------------------------------

/**
 * The fixed public salt: utf8("woco-pod-cert-public-v1").
 *
 * There is NO private-salt counterpart and that is deliberate. An issuer's log
 * is the supply-auditable source — "how many of this badge exist, and does the
 * count match the manifest" is a question anyone must be able to ask. Exposing
 * a private-salt helper would invite a partition that has no reader.
 */
export function podCertPublicSalt(): Uint8Array {
  return publicTopicSalt(POD_CERT_TYPE, POD_CERT_VERSION);
}

/**
 * The issuer's certificate-log topic for one badge type and BAND.
 *
 * PER-TYPE SUBJECT DERIVATION (the discipline leaves this slot open per type):
 * the subject IS the badge `manifestRef`, used verbatim. No hashing domain is
 * wrapped around it because a manifestRef is already a 32-byte commitment to
 * the manifest body — hashing it again would only add a step that a third-party
 * indexer could get wrong.
 *
 * Note what this topic is NOT keyed by: the holder. One badge type is one log,
 * appended one SOC version per issuance, inside the ISSUER's feed address space
 * (`chunk address = keccak256(identifier || owner)`). That is what makes supply
 * auditable and what makes the band mandatory — unlike likes and follows, a
 * certificate feed has a growth axis and its head moves.
 *
 * The band is REQUIRED and never defaulted: on the write path a wrong band
 * targets a version that already exists, which Bee dedupes silently.
 */
export function podCertLogTopic(salt: Uint8Array, badge: Bytes32Hex, band: number): string {
  return statementTopic(POD_CERT_TYPE, POD_CERT_VERSION, salt, subjectToBytes(badge as Hex0x), band);
}

/** The issuer's index of badge types it has certified, for one band. */
export function podCertSubjectIndexTopic(salt: Uint8Array, band: number): string {
  return subjectIndexTopic(POD_CERT_TYPE, POD_CERT_VERSION, salt, band);
}

export type PodCertSubjectIndex = SubjectIndexV2<typeof POD_CERT_SUBJECT_INDEX_FORMAT>;

export function validatePodCertSubjectIndex(value: unknown): value is PodCertSubjectIndex {
  return validateSubjectIndexV2(value, POD_CERT_SUBJECT_INDEX_FORMAT);
}

// ---------------------------------------------------------------------------
// Strict validation — the closed-schema rule, made executable
// ---------------------------------------------------------------------------

const BYTES32_RE = /^0x[0-9a-f]{64}$/;
const ED25519_PUB_RE = /^[0-9a-f]{64}$/;
const X25519_PUB_RE = /^[0-9a-f]{64}$/;
const ED25519_SIG_RE = /^[0-9a-f]{128}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** formatId ":" base64url (unpadded) — the frozen `exitTokens` shape. */
const EVIDENCE_RE = /^[a-z0-9.-]+:[A-Za-z0-9_-]+$/;
/** Printable ASCII, no spaces, bounded. An audience with a space in it could
 *  not be quoted unambiguously into a human-readable door log. */
const AUDIENCE_RE = /^[\x21-\x7e]{1,256}$/;
/** base64url unpadded, ≥22 chars ⇒ ≥16 bytes of verifier-chosen entropy. */
const NONCE_RE = /^[A-Za-z0-9_-]{22,256}$/;

function hasExactKeys(o: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(o);
  return (
    required.every((k) => k in o) &&
    keys.every((k) => required.includes(k) || (optional.includes(k) && o[k] !== undefined))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Closed-schema validation of the UNSIGNED certificate. Dispatch happens
 * BEFORE this: a reader reads `format` first and applies this only for
 * `woco.pod-cert.v1`, so a v2 object — or a credit statement — fails whole
 * instead of half-parsing. Unknown fields are REJECTED, not ignored; absent
 * optionals are OMITTED, never null (both are what make the DAG-CBOR digest
 * unambiguous).
 */
function validateUnsignedCert(value: unknown): value is UnsignedPodCertV1 {
  if (!isPlainObject(value)) return false;
  const o = value;
  if (!hasExactKeys(o, ["format", "badge", "holder", "issuedAt"], ["encPubKey", "evidence"])) return false;
  if (o.format !== POD_CERT_FORMAT) return false;
  if (typeof o.badge !== "string" || !BYTES32_RE.test(o.badge)) return false;
  if (typeof o.holder !== "string" || !ED25519_PUB_RE.test(o.holder)) return false;
  if (typeof o.issuedAt !== "string" || !DATE_RE.test(o.issuedAt)) return false;
  if ("encPubKey" in o && (typeof o.encPubKey !== "string" || !X25519_PUB_RE.test(o.encPubKey))) return false;
  if ("evidence" in o) {
    if (!Array.isArray(o.evidence)) return false;
    if (!o.evidence.every((e) => typeof e === "string" && EVIDENCE_RE.test(e))) return false;
  }
  return true;
}

/** Closed-schema validation of a full signed certificate (shape only — see
 *  {@link verifyPodCert} for shape + signature). */
export function validatePodCertV1(value: unknown): value is PodCertV1 {
  if (!isPlainObject(value)) return false;
  const o = value;
  if (typeof o.issuerSig !== "string" || !ED25519_SIG_RE.test(o.issuerSig)) return false;
  const { issuerSig: _sig, ...unsigned } = o;
  return validateUnsignedCert(unsigned);
}

/** Closed-schema validation of the UNSIGNED challenge. */
function validateUnsignedChallenge(value: unknown): value is UnsignedPodCertChallengeV1 {
  if (!isPlainObject(value)) return false;
  const o = value;
  if (!hasExactKeys(o, ["format", "badge", "holder", "audience", "nonce", "expiresAt"])) return false;
  if (o.format !== POD_CERT_CHALLENGE_FORMAT) return false;
  if (typeof o.badge !== "string" || !BYTES32_RE.test(o.badge)) return false;
  if (typeof o.holder !== "string" || !ED25519_PUB_RE.test(o.holder)) return false;
  if (typeof o.audience !== "string" || !AUDIENCE_RE.test(o.audience)) return false;
  if (typeof o.nonce !== "string" || !NONCE_RE.test(o.nonce)) return false;
  if (typeof o.expiresAt !== "number" || !Number.isSafeInteger(o.expiresAt) || o.expiresAt <= 0) return false;
  return true;
}

/** Closed-schema validation of a full signed challenge (shape only). */
export function validatePodCertChallengeV1(value: unknown): value is PodCertChallengeV1 {
  if (!isPlainObject(value)) return false;
  const o = value;
  if (typeof o.holderSig !== "string" || !ED25519_SIG_RE.test(o.holderSig)) return false;
  const { holderSig: _sig, ...unsigned } = o;
  return validateUnsignedChallenge(unsigned);
}

// ---------------------------------------------------------------------------
// Canonicalisation, signing, verification
// ---------------------------------------------------------------------------

/**
 * Rebuild the unsigned certificate as a fresh literal in a FIXED key order.
 * dag-cbor sorts map keys, so this is not needed for digest determinism — it is
 * defence against a caller's object carrying own-keys the validator would have
 * rejected arriving here via a cast, and it enforces omitted-not-null for the
 * optionals mechanically.
 */
function canonicalUnsignedCert(u: UnsignedPodCertV1): UnsignedPodCertV1 {
  return {
    format: u.format,
    badge: u.badge,
    holder: u.holder,
    issuedAt: u.issuedAt,
    ...(u.encPubKey !== undefined ? { encPubKey: u.encPubKey } : {}),
    ...(u.evidence !== undefined ? { evidence: [...u.evidence] } : {}),
  };
}

function canonicalUnsignedChallenge(u: UnsignedPodCertChallengeV1): UnsignedPodCertChallengeV1 {
  return {
    format: u.format,
    badge: u.badge,
    holder: u.holder,
    audience: u.audience,
    nonce: u.nonce,
    expiresAt: u.expiresAt,
  };
}

/** The signing digest for a certificate. Throws on an invalid shape — a digest
 *  of an unvalidated object must never exist. */
export function podCertDigest(unsigned: UnsignedPodCertV1): Uint8Array {
  if (!validateUnsignedCert(unsigned)) throw new Error("invalid woco.pod-cert.v1 unsigned certificate");
  return statementSigningDigest(POD_CERT_SIGNING_PREFIX, canonicalUnsignedCert(unsigned));
}

/** The signing digest for a challenge. Throws on an invalid shape. */
export function podCertChallengeDigest(unsigned: UnsignedPodCertChallengeV1): Uint8Array {
  if (!validateUnsignedChallenge(unsigned)) {
    throw new Error("invalid woco.pod-cert-challenge.v1 unsigned challenge");
  }
  return statementSigningDigest(POD_CERT_CHALLENGE_SIGNING_PREFIX, canonicalUnsignedChallenge(unsigned));
}

/**
 * Sign a certificate as the badge type's issuer. `issuerPrivKey` is the 32-byte
 * ed25519 key whose public half is the manifest's `issuerPubkey` — the SAME key
 * that signs POD manifests, so display identity and signing identity join with
 * nothing new built.
 *
 * `expectedIssuerPubkey` is required, not optional: a certificate signed by the
 * wrong key of a multi-key issuer verifies against nothing and is discovered
 * only at a door, by a holder who cannot get in. Refuse at the point of signing.
 */
export function signPodCert(
  unsigned: UnsignedPodCertV1,
  issuerPrivKey: Uint8Array,
  expectedIssuerPubkey: Hex32,
): PodCertV1 {
  const digest = podCertDigest(unsigned);
  const pub = bytesToHex(ed25519.getPublicKey(issuerPrivKey));
  if (pub !== expectedIssuerPubkey) {
    throw new Error("issuer key mismatch: this private key is not the badge manifest's issuerPubkey");
  }
  const cert: PodCertV1 = {
    ...canonicalUnsignedCert(unsigned),
    issuerSig: bytesToHex(ed25519.sign(digest, issuerPrivKey)),
  };
  const size = jsonByteLength(cert);
  if (size > MAX_POD_CERT_BYTES) {
    throw new Error(
      `certificate is ${size} bytes, over the ${MAX_POD_CERT_BYTES}-byte limit — trim \`evidence\``,
    );
  }
  return cert;
}

/**
 * Sign a challenge as the holder. `holderPrivKey` is the 32-byte ed25519 POD
 * key; the challenge's `holder` MUST be its public key.
 *
 * CALLER'S RULE, and it cannot be enforced here: this signs whatever `audience`
 * it is handed. `audience` is what stops one door's answer being replayed at
 * another, so a holder client must sign only a challenge whose audience is the
 * door it is actually standing at — otherwise a relay puts its own door's
 * challenge in front of a holder who thinks they are entering somewhere else,
 * and gets a valid answer for it.
 */
export function signPodCertChallenge(
  unsigned: UnsignedPodCertChallengeV1,
  holderPrivKey: Uint8Array,
): PodCertChallengeV1 {
  const digest = podCertChallengeDigest(unsigned);
  const pub = bytesToHex(ed25519.getPublicKey(holderPrivKey));
  if (pub !== unsigned.holder) {
    throw new Error("holder key mismatch: challenge.holder is not this private key's public key");
  }
  return { ...canonicalUnsignedChallenge(unsigned), holderSig: bytesToHex(ed25519.sign(digest, holderPrivKey)) };
}

/**
 * Full acceptance check for a certificate: format dispatch → closed-schema
 * validation → issuer signature, in that order. Returns false on any failure,
 * never throws (mirrors `verifySignedManifest` / `verifyCreditStatement`).
 *
 * `issuerPubkey` MUST come from the badge manifest the caller verified against
 * `cert.badge` — see `verifyPodCertIssuer`. Passing an issuer key from anywhere
 * else (a directory entry, a gate config, a URL) checks a signature against a
 * key nothing binds to the badge, which is not a check at all.
 */
export function verifyPodCert(value: unknown, issuerPubkey: Hex32): value is PodCertV1 {
  try {
    if (!ED25519_PUB_RE.test(issuerPubkey)) return false;
    if (!validatePodCertV1(value)) return false;
    const { issuerSig, ...unsigned } = value;
    const digest = statementSigningDigest(POD_CERT_SIGNING_PREFIX, canonicalUnsignedCert(unsigned));
    return ed25519.verify(hexToBytes(issuerSig), digest, hexToBytes(issuerPubkey));
  } catch {
    return false;
  }
}

/** Full acceptance check for a challenge: dispatch → schema → holder signature.
 *  Says nothing about freshness, audience or which certificate it answers —
 *  that is the door's job, in `holdings.ts`. */
export function verifyPodCertChallenge(value: unknown): value is PodCertChallengeV1 {
  try {
    if (!validatePodCertChallengeV1(value)) return false;
    const { holderSig, ...unsigned } = value;
    const digest = statementSigningDigest(
      POD_CERT_CHALLENGE_SIGNING_PREFIX,
      canonicalUnsignedChallenge(unsigned),
    );
    return ed25519.verify(hexToBytes(holderSig), digest, hexToBytes(value.holder));
  } catch {
    return false;
  }
}
