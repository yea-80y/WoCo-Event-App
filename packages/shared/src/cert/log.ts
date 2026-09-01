/**
 * `woco.cert-log.v1` — one SOC version of an issuer's per-badge certificate
 * log, on the v2 issuer curve. Design record: docs/SWARM_SOCIAL_PLAN.md,
 * BUILD RECORD slice 3; curve migration: HANDOVER-pod-curve-migration.md.
 *
 * WHAT CHANGED from `woco.pod-cert-log.v1`: the certificates inside are
 * `woco.cert.v1`, and verification takes an `IssuerAddress` rather than an
 * ed25519 issuer pubkey. The envelope shape, the size rule and the
 * drop-individually rule are unchanged.
 *
 * WHY AN ENVELOPE AT ALL. The log is ONE topic per badge type, inside the
 * issuer's feed address space, holding every holder's certificate — unlike
 * credits, where each (holder, subject) has its own topic and nothing ever
 * contends. Writing one certificate per SOC version would make a 500-holder
 * issuance 500 sequential round trips, and would make every future enumeration
 * pass — the supply audit, the per-drop encryption publisher looking for current
 * holders — pay 500 reads forever. Batching makes both several times cheaper
 * and shortens band walks for the log's whole life.
 *
 * The one advantage single-certificate versions appear to have — counting supply
 * by version arithmetic, with no payload reads — is illusory: a certificate
 * holding is presence, not quantity, so re-issuance means a sound audit must
 * read payloads and dedupe by holder in EITHER model.
 *
 * TRANSPORT TIER, deliberately. The envelope carries no identity signature and
 * claims no signing prefix, on the same stakes argument as the subject index: a
 * forged envelope can only carry certificates that fail issuer verification, or
 * omit certificates — and the SOC signature already binds who wrote the feed.
 * Every certificate inside is independently verifiable and independently
 * dropped, so one bad certificate never voids its page-mates.
 *
 * NOTHING HERE CHANGES `woco.cert.v1`. Certificates nest byte-identical.
 */

import { utf8ToBytes } from "@noble/hashes/utils.js";
import { SOC_MAX_PAYLOAD_SIZE } from "../swarm/soc.js";
import type { IssuerAddress } from "../crypto/brands.js";
import { validateCertV1, verifyCertV1, type CertV1 } from "./types.js";

export const CERT_LOG_FORMAT = "woco.cert-log.v1" as const;

/**
 * Serialized byte length of a value as it will be written to a feed.
 *
 * MODULE-PRIVATE for the same reason as the twin in `types.ts`:
 * `pod-cert/types.ts` exports a `jsonByteLength`, and both modules are
 * re-exported from the package barrel, so a second export of that name would
 * break it.
 */
function jsonByteLength(value: unknown): number {
  return utf8ToBytes(JSON.stringify(value)).length;
}

/**
 * A single SOC payload is capped at {@link SOC_MAX_PAYLOAD_SIZE}; above that a
 * content feed PAGES across `{topic}/p1 … /pN` behind a `_woco_mc` manifest.
 * Taken from the SOC layer rather than restated, so the two can never drift
 * into a packer that believes it fits when it does not.
 *
 * A log page MUST NEVER reach that path, and this is load-bearing rather than
 * tidy. A paged log version is a torn-write hazard — issue #315 is open on
 * exactly that, a torn multi-page feed write bricking a feed — and paging would
 * destroy the atomicity that makes the write's read-back verification mean
 * anything. An unverifiable write here is not a cosmetic gap: until the holder
 * import slice exists, a certificate lives NOWHERE but this log, so a write that
 * cannot be verified is a certificate that may simply not exist.
 */
export const CERT_LOG_PAGE_MAX_BYTES: number = SOC_MAX_PAYLOAD_SIZE;

/**
 * One SOC version of the log. Closed schema: exactly `format` and `certs`,
 * which also guarantees it can never carry the paging manifest's `_woco_mc` key.
 */
export interface CertLogPageV1 {
  format: typeof CERT_LOG_FORMAT;
  /** 1..n fully signed certificates. Never empty — an empty page is a wasted
   *  version and a reader would have to special-case it forever. */
  certs: CertV1[];
}

/** Closed-schema validation. Shape only — see {@link verifyCertLogPage} for
 *  shape plus per-certificate issuer signatures. */
export function validateCertLogPageV1(value: unknown): value is CertLogPageV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.length !== 2 || keys[0] !== "certs" || keys[1] !== "format") return false;
  if (o.format !== CERT_LOG_FORMAT) return false;
  if (!Array.isArray(o.certs) || o.certs.length === 0) return false;
  return o.certs.every((c) => validateCertV1(c));
}

/**
 * Pack certificates into pages, greedily, each within one inline chunk.
 *
 * Throws if a single certificate cannot fit a page alone — which the signing
 * bound makes unreachable, and which is therefore asserted rather than handled:
 * silently dropping it would lose a certificate, and paging it would brick the
 * feed.
 */
export function packCertLogPages(certs: readonly CertV1[]): CertLogPageV1[] {
  const pages: CertLogPageV1[] = [];
  let current: CertV1[] = [];

  const fits = (candidate: CertV1[]): boolean =>
    jsonByteLength({ format: CERT_LOG_FORMAT, certs: candidate }) <= CERT_LOG_PAGE_MAX_BYTES;

  for (const cert of certs) {
    if (!fits([cert])) {
      throw new Error(
        `a single certificate exceeds ${CERT_LOG_PAGE_MAX_BYTES} bytes and cannot be written to a log page`,
      );
    }
    if (current.length > 0 && !fits([...current, cert])) {
      pages.push({ format: CERT_LOG_FORMAT, certs: current });
      current = [];
    }
    current.push(cert);
  }
  if (current.length > 0) pages.push({ format: CERT_LOG_FORMAT, certs: current });
  return pages;
}

/**
 * The certificates on a page that genuinely carry `issuer`'s signature.
 *
 * Failures are DROPPED INDIVIDUALLY rather than voiding the page: a reader is
 * consuming bytes from a public address, and one unverifiable certificate must
 * not hide the holders alongside it. Returns empty for a page that is not a
 * well-formed log page at all.
 */
export function verifyCertLogPage(value: unknown, issuer: IssuerAddress): CertV1[] {
  if (!validateCertLogPageV1(value)) return [];
  return value.certs.filter((c) => verifyCertV1(c, issuer));
}

// ---------------------------------------------------------------------------
// NOT PORTED, deliberately: `CertLogCursor`, `firstCertLogCursor`,
// `nextCertLogCursor` and `holdersFromLogPages`.
//
// All four are LOG-FORMAT-AGNOSTIC — band/version arithmetic over the
// discipline's `LAST_VERSION_IN_BAND`, and a first-seen dedupe over holder
// keys, neither of which knows anything about a certificate's issuer curve.
// Copying them here would fork the highest-stakes arithmetic in the rail into
// two identical implementations that could drift, and would collide on the
// package barrel besides. They stay in `pod-cert/log.ts` and are imported from
// there until the v1 module is deleted (PR 5a), which is where they move.
// ---------------------------------------------------------------------------
