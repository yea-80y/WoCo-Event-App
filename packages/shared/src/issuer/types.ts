/**
 * `woco.issuer-statement.v1` / `woco.issuer-log.v1` — the ISSUER REGISTRY
 * (issuer-curve migration PR 5b; design record: HANDOVER-pod-curve-migration.md).
 *
 * The registry is what makes the issuing key ROTATABLE without a new secret at
 * rest: a generation bump is a public, parent-signed statement — not a new
 * escrow slot — and the escrowed seed re-derives every generation on recovery.
 *
 * ZERO SERVER TRUST, by construction: every statement is EIP-712-signed by the
 * PARENT wallet (the identity of record) and carries the issuing key's own
 * proof of possession, so any client holding this module verifies
 * `parent → issuerAddress` from the bytes alone. The server only RELAYS the
 * feed write (session-authenticated, owner-stamped — the #433 lesson: the
 * record must be unwritable by anyone but its owner); it attests nothing a
 * verifier needs to believe.
 *
 * THE SEED ENTRY IS NOT A STATEMENT. Generation 0 is pinned server-side at
 * first create from the create payload's PoP binding (PR 5a,
 * `.data/issuer-bindings.json`) — no ceremony, no signature prompt beyond what
 * publishing already required. A parent MAY publish a gen-0 statement to make
 * the binding client-verifiable, and MUST publish one to rotate. An empty log
 * therefore means "gen 0, server-pinned", never "no issuer".
 *
 * ROTATION CONTAINMENT — the rule the PR 1 addendum requires stating here:
 * gen-rotation contains a leaked issuing key on the CERT rail only if old-gen
 * acceptance is anchored to cert-log inclusion AS OF THE BUMP. Certificates
 * live in the issuer's append-only cert log; a rotation statement's
 * publication marks a boundary, and certificates from a retired generation
 * are acceptable only if their log position precedes it. v1 enforces the
 * coarse server-side version — a badge whose manifest names a RETIRED issuer
 * is refused at the gate write boundary — and doors verifying offline should
 * treat a retired-gen manifest as unverifiable once they learn of the bump.
 * A leaked key can therefore mint nothing durable after the bump; what it
 * minted before is bounded by the log the real issuer can audit.
 *
 * `prevSig` — the previous generation's co-signature — is OPTIONAL, and its
 * absence is a FLAG, not a refusal. The issuing key is seed-derived, so a
 * "lost key" rotation implies seed loss (full account recovery), and a
 * COMPROMISED key could co-sign its own replacement anyway: requiring the
 * co-signature would block exactly the break-glass case it cannot secure.
 * Present = continuity proven; absent = a visible discontinuity every reader
 * sees. Equivocation is flagged rather than prevented, everywhere in this
 * design.
 *
 * NOTHING KEYS OFF SIGNATURE BYTES (ECDSA malleability): every check below
 * recovers an address and compares; high-s and malformed encodings are
 * refused, never normalised.
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { eip712Digest } from "../auth/eip712-digest.js";
import { isIssuerAddress, type IssuerAddress } from "../crypto/brands.js";
import {
  buildIssuerBindingMessage,
  recoverPersonalSigner,
} from "../crypto/issuing.js";
import type { Hex0x } from "../types.js";

// ---------------------------------------------------------------------------
// Formats, domain, message shapes
// ---------------------------------------------------------------------------

export const ISSUER_STATEMENT_FORMAT = "woco.issuer-statement.v1" as const;
export const ISSUER_LOG_FORMAT = "woco.issuer-log.v1" as const;

/**
 * EIP-712 domain for issuer-registry statements. Distinct salt from every
 * other WoCo domain so a phished statement signature can never be replayed as
 * a session, a derivation, or a claim — and vice versa. Unlike the FIXED-NONCE
 * derivation domains, a statement leaks no key material if signed under
 * deception; what it could assert is bounded by the server relay only
 * accepting it inside the parent's own authenticated session.
 */
export const ISSUER_REGISTRY_DOMAIN = {
  name: "WoCo Issuer Registry",
  version: "1",
  salt: "0x9a887103e2fde6c7e86e9cf5985ec1c6a5cf9bfd3e0e8340ecbb2e245ee0c43d",
} as const;

/** EIP-712 types for IssuerStatement. `certLogOwner` is always present in the
 *  typed data — EIP-712 has no optionals — with the zero address meaning
 *  "none declared" (an organiser who has never minted a certificate badge). */
export const ISSUER_STATEMENT_TYPES = {
  IssuerStatement: [
    { name: "parent", type: "address" },
    { name: "issuer", type: "address" },
    { name: "gen", type: "uint256" },
    { name: "certLogOwner", type: "address" },
    { name: "reason", type: "string" },
    { name: "issuedAt", type: "string" },
  ],
} as const;

/** The personal-sign domain line for rotation co-signatures. */
export const ISSUER_ROTATION_SIGNING_DOMAIN = "woco-issuer-rotation-v1";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * The EXACT ASCII message the PREVIOUS generation's issuing key signs to
 * co-attest a rotation:
 *
 *   woco-issuer-rotation-v1\n{parent}\n{prevGen}\n{newGen}\n{newIssuer}
 *
 * ≥ 113 bytes — never 32 (SOC-disjoint by length), and its domain line keeps
 * it disjoint from the manifest / cert / binding messages the same key family
 * signs (pinned in test/crypto/cross-protocol.test.ts). Binding the NEW issuer
 * and both generations means the co-signature cannot be replayed to endorse a
 * different successor or a different hop.
 */
export function buildIssuerRotationMessage(
  parent: string,
  prevGen: number,
  newGen: number,
  newIssuer: string,
): string {
  if (typeof parent !== "string" || !/^0x[0-9a-f]{40}$/.test(parent)) {
    throw new Error("rotation message: parent must be a 0x-prefixed lowercase 20-byte address");
  }
  if (!Number.isInteger(prevGen) || prevGen < 0 || !Number.isInteger(newGen) || newGen !== prevGen + 1) {
    throw new Error(`rotation message: generations must step by exactly 1 (got ${prevGen} → ${newGen})`);
  }
  if (typeof newIssuer !== "string" || !/^0x[0-9a-f]{40}$/.test(newIssuer)) {
    throw new Error("rotation message: newIssuer must be a 0x-prefixed lowercase 20-byte address");
  }
  return `${ISSUER_ROTATION_SIGNING_DOMAIN}\n${parent}\n${prevGen}\n${newGen}\n${newIssuer}`;
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface IssuerStatementV1 {
  format: typeof ISSUER_STATEMENT_FORMAT;
  /** The identity of record — 0x + 40 lowercase hex. Inside the signed bytes. */
  parent: Hex0x;
  /** The issuing ADDRESS this statement binds (gen `gen`'s key). */
  issuer: IssuerAddress;
  /** Generation being declared. 0 = the seed binding made public. */
  gen: number;
  /** The issuer's content-feed address (their cert logs' SOC owner), or the
   *  zero address when none is declared. Carried HERE — parent-signed — so the
   *  split-view-equivocation gap on `PodDirectoryEntry.certLogOwner`
   *  (an unverified display hint) closes client-verifiably. */
  certLogOwner: Hex0x;
  /** Free-text, why this statement exists ("seed", "rotation: device lost").
   *  Bounded, display-only, never trusted. */
  reason: string;
  /** ISO-8601 instant, SELF-DECLARED — nothing timestamps a feed write.
   *  Syntactic check only, same posture as `CertV1.issuedAt`. */
  issuedAt: string;
  /** EIP-712 signature by `parent` over the six fields above (r||s||v). */
  parentSig: Hex0x;
  /** Proof of possession: the gen-`gen` issuing key's personal-sign over
   *  `buildIssuerBindingMessage(parent, gen)` — the same statement every
   *  create payload carries (crypto/issuing.ts). */
  bindingSig: Hex0x;
  /** OPTIONAL rotation co-signature by the PREVIOUS generation's key over
   *  `buildIssuerRotationMessage(parent, gen-1, gen, issuer)`. Only
   *  meaningful for gen > 0; its absence is a flagged discontinuity. */
  prevSig?: Hex0x;
}

/** The per-parent registry log, as published on the `woco/issuer/{parent}`
 *  platform feed. Append-only by convention: one statement per generation. */
export interface IssuerLogV1 {
  format: typeof ISSUER_LOG_FORMAT;
  parent: Hex0x;
  statements: IssuerStatementV1[];
}

/** Feed topic NAME for a parent's registry log (server wraps it with
 *  `Topic.fromString`, like every other `woco/...` topic). */
export function issuerRegistryTopicName(parent: string): string {
  return `woco/issuer/${parent.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Validation — closed schema, refuse never normalise
// ---------------------------------------------------------------------------

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const SIG_RE = /^0x[0-9a-f]{130}$/;
/** Syntactic ISO-8601 instant — same leniency class as CertV1.issuedAt. */
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const MAX_REASON_LENGTH = 200;
/** Generations are declared in strictly small integers; anything huge is a
 *  producer bug, not a rotation history. */
const MAX_GEN = 1_000_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(o: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(o);
  return (
    required.every((k) => k in o) &&
    keys.every((k) => required.includes(k) || (optional.includes(k) && o[k] !== undefined))
  );
}

/** Closed-schema validation (shape only — see {@link verifyIssuerStatement}
 *  for shape + all three signatures). */
export function validateIssuerStatementV1(value: unknown): value is IssuerStatementV1 {
  if (!isPlainObject(value)) return false;
  const o = value;
  if (
    !hasExactKeys(
      o,
      ["format", "parent", "issuer", "gen", "certLogOwner", "reason", "issuedAt", "parentSig", "bindingSig"],
      ["prevSig"],
    )
  ) {
    return false;
  }
  if (o.format !== ISSUER_STATEMENT_FORMAT) return false;
  if (typeof o.parent !== "string" || !ADDRESS_RE.test(o.parent)) return false;
  if (!isIssuerAddress(o.issuer)) return false;
  if (!Number.isInteger(o.gen) || (o.gen as number) < 0 || (o.gen as number) > MAX_GEN) return false;
  if (typeof o.certLogOwner !== "string" || !ADDRESS_RE.test(o.certLogOwner)) return false;
  if (typeof o.reason !== "string" || o.reason.length > MAX_REASON_LENGTH) return false;
  if (typeof o.issuedAt !== "string" || !INSTANT_RE.test(o.issuedAt)) return false;
  if (typeof o.parentSig !== "string" || !SIG_RE.test(o.parentSig)) return false;
  if (typeof o.bindingSig !== "string" || !SIG_RE.test(o.bindingSig)) return false;
  if ("prevSig" in o && (typeof o.prevSig !== "string" || !SIG_RE.test(o.prevSig))) return false;
  return true;
}

export function validateIssuerLogV1(value: unknown): value is IssuerLogV1 {
  if (!isPlainObject(value)) return false;
  const o = value;
  if (!hasExactKeys(o, ["format", "parent", "statements"])) return false;
  if (o.format !== ISSUER_LOG_FORMAT) return false;
  if (typeof o.parent !== "string" || !ADDRESS_RE.test(o.parent)) return false;
  if (!Array.isArray(o.statements)) return false;
  return o.statements.every((s) => validateIssuerStatementV1(s));
}

// ---------------------------------------------------------------------------
// Verification — recover and compare, refuse malleability
// ---------------------------------------------------------------------------

/**
 * Recover the signer address of a RAW 32-byte digest (EIP-712's final hash),
 * with the same refusals as `recoverPersonalSigner`: malformed hex, v outside
 * {27, 28} and high-s all return null. MODULE-PRIVATE deliberately — exporting
 * a raw-digest recover invites a raw-digest SIGNER, and signing bare 32-byte
 * digests is exactly the SOC-confusable scheme `crypto/issuing.ts` forbids.
 * Recovery over the EIP-712 envelope digest is safe: the 0x1901 prefix makes
 * the preimage domain disjoint from every personal-sign message.
 */
function recoverDigestSigner(digest: Uint8Array, signature: unknown): string | null {
  try {
    if (digest.length !== 32) return null;
    if (typeof signature !== "string" || !SIG_RE.test(signature)) return null;
    const raw = hexToBytes(signature.slice(2));
    const v = raw[64]!;
    if (v !== 27 && v !== 28) return null;
    const recovered = new Uint8Array(65);
    recovered[0] = v - 27;
    recovered.set(raw.subarray(0, 64), 1);
    const sig = secp256k1.Signature.fromBytes(recovered, "recovered");
    if (sig.hasHighS()) return null;
    const pub = sig.recoverPublicKey(digest).toBytes(false);
    return "0x" + bytesToHex(keccak_256(pub.subarray(1)).subarray(12));
  } catch {
    return null;
  }
}

/** The EIP-712 digest the parent signs for a statement. Exported so a client
 *  (or a wallet UI) can present exactly what will be signed. */
export function issuerStatementDigest(
  s: Pick<IssuerStatementV1, "parent" | "issuer" | "gen" | "certLogOwner" | "reason" | "issuedAt">,
): Uint8Array {
  return eip712Digest(
    ISSUER_REGISTRY_DOMAIN,
    "IssuerStatement",
    ISSUER_STATEMENT_TYPES.IssuerStatement,
    {
      parent: s.parent,
      issuer: s.issuer,
      gen: s.gen,
      certLogOwner: s.certLogOwner,
      reason: s.reason,
      issuedAt: s.issuedAt,
    },
  );
}

export type IssuerStatementVerdict =
  | { ok: true; statement: IssuerStatementV1 }
  | { ok: false; error: string };

/**
 * Full statement verification: closed schema → parent EIP-712 recovery →
 * issuing-key PoP recovery. Says nothing about the statement's PLACE in a log
 * (gen sequencing, prevSig) — that is {@link verifyIssuerLog}'s job, because
 * the previous generation's address lives in the previous statement.
 */
export function verifyIssuerStatement(value: unknown): IssuerStatementVerdict {
  if (!validateIssuerStatementV1(value)) {
    return { ok: false, error: "not a valid woco.issuer-statement.v1" };
  }
  const s = value;
  const recoveredParent = recoverDigestSigner(issuerStatementDigest(s), s.parentSig);
  if (!recoveredParent) {
    return { ok: false, error: "parentSig is not a valid signature over this statement" };
  }
  if (recoveredParent !== s.parent) {
    return { ok: false, error: "parentSig was not made by the statement's parent" };
  }
  const boundIssuer = recoverPersonalSigner(buildIssuerBindingMessage(s.parent, s.gen), s.bindingSig);
  if (boundIssuer !== s.issuer) {
    return { ok: false, error: "bindingSig does not prove possession of the stated issuer key" };
  }
  return { ok: true, statement: s };
}

export type IssuerLogVerdict =
  | {
      ok: true;
      log: IssuerLogV1;
      /** The latest statement — the current binding a verifier should use. */
      current: IssuerStatementV1;
      /** Generations whose rotation lacked the previous key's co-signature —
       *  visible discontinuities, flagged for the reader to judge. */
      unattestedRotations: number[];
    }
  | { ok: false; error: string };

/**
 * Verify a whole registry log: every statement verifies, generations start at
 * the log's first entry and step by exactly 1, every statement names the same
 * parent as the log, and each present `prevSig` recovers to the PREVIOUS
 * statement's issuer over the rotation message.
 *
 * An absent `prevSig` on a rotation does not fail the log — it is returned in
 * `unattestedRotations` for the caller to render as the discontinuity it is.
 */
export function verifyIssuerLog(value: unknown): IssuerLogVerdict {
  if (!validateIssuerLogV1(value)) {
    return { ok: false, error: "not a valid woco.issuer-log.v1" };
  }
  const log = value;
  if (log.statements.length === 0) {
    return { ok: false, error: "an empty log carries no binding — read the server pin instead" };
  }
  const unattested: number[] = [];
  for (let i = 0; i < log.statements.length; i++) {
    const s = log.statements[i]!;
    if (s.parent !== log.parent) {
      return { ok: false, error: `statement ${i} names a different parent than the log` };
    }
    const v = verifyIssuerStatement(s);
    if (!v.ok) return { ok: false, error: `statement ${i}: ${v.error}` };
    if (i > 0) {
      const prev = log.statements[i - 1]!;
      if (s.gen !== prev.gen + 1) {
        return { ok: false, error: `statement ${i} skips generations (${prev.gen} → ${s.gen})` };
      }
      if (s.prevSig !== undefined) {
        const coSigner = recoverPersonalSigner(
          buildIssuerRotationMessage(s.parent, prev.gen, s.gen, s.issuer),
          s.prevSig,
        );
        if (coSigner !== prev.issuer) {
          return { ok: false, error: `statement ${i}: prevSig is not the previous issuer's co-signature` };
        }
      } else {
        unattested.push(s.gen);
      }
    } else if (s.prevSig !== undefined) {
      return { ok: false, error: "the first statement in a log cannot carry a rotation co-signature" };
    }
  }
  return {
    ok: true,
    log,
    current: log.statements[log.statements.length - 1]!,
    unattestedRotations: unattested,
  };
}
