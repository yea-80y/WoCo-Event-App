/**
 * `woco.pod-cert-log.v1` — one SOC version of an issuer's per-badge certificate
 * log. Design record: docs/SWARM_SOCIAL_PLAN.md, BUILD RECORD slice 3.
 *
 * WHY AN ENVELOPE AT ALL. The log is ONE topic per badge type, inside the
 * issuer's feed address space, holding every holder's certificate — unlike
 * credits, where each (holder, subject) has its own topic and nothing ever
 * contends. Writing one certificate per SOC version would make a 500-holder
 * issuance 500 sequential round trips, and would make every future enumeration
 * pass — the supply audit, the per-drop encryption publisher looking for current
 * holders — pay 500 reads forever. Batching makes both ~8x cheaper and shortens
 * band walks for the log's whole life.
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
 * NOTHING HERE CHANGES `woco.pod-cert.v1`. Certificates nest byte-identical.
 */

import { LAST_VERSION_IN_BAND } from "../statement/discipline.js";
import { SOC_MAX_PAYLOAD_SIZE } from "../swarm/soc.js";
import type { Hex32 } from "../pod/types.js";
import { jsonByteLength, validatePodCertV1, verifyPodCert, type PodCertV1 } from "./types.js";

export const POD_CERT_LOG_FORMAT = "woco.pod-cert-log.v1" as const;

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
export const POD_CERT_LOG_PAGE_MAX_BYTES: number = SOC_MAX_PAYLOAD_SIZE;

/**
 * One SOC version of the log. Closed schema: exactly `format` and `certs`,
 * which also guarantees it can never carry the paging manifest's `_woco_mc` key.
 */
export interface PodCertLogPageV1 {
  format: typeof POD_CERT_LOG_FORMAT;
  /** 1..n fully signed certificates. Never empty — an empty page is a wasted
   *  version and a reader would have to special-case it forever. */
  certs: PodCertV1[];
}

/** Closed-schema validation. Shape only — see {@link verifyPodCertLogPage} for
 *  shape plus per-certificate issuer signatures. */
export function validatePodCertLogPageV1(value: unknown): value is PodCertLogPageV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.length !== 2 || keys[0] !== "certs" || keys[1] !== "format") return false;
  if (o.format !== POD_CERT_LOG_FORMAT) return false;
  if (!Array.isArray(o.certs) || o.certs.length === 0) return false;
  return o.certs.every((c) => validatePodCertV1(c));
}

/**
 * Pack certificates into pages, greedily, each within one inline chunk.
 *
 * Throws if a single certificate cannot fit a page alone — which the signing
 * bound makes unreachable, and which is therefore asserted rather than handled:
 * silently dropping it would lose a certificate, and paging it would brick the
 * feed.
 */
export function packPodCertLogPages(certs: readonly PodCertV1[]): PodCertLogPageV1[] {
  const pages: PodCertLogPageV1[] = [];
  let current: PodCertV1[] = [];

  const fits = (candidate: PodCertV1[]): boolean =>
    jsonByteLength({ format: POD_CERT_LOG_FORMAT, certs: candidate }) <= POD_CERT_LOG_PAGE_MAX_BYTES;

  for (const cert of certs) {
    if (!fits([cert])) {
      throw new Error(
        `a single certificate exceeds ${POD_CERT_LOG_PAGE_MAX_BYTES} bytes and cannot be written to a log page`,
      );
    }
    if (current.length > 0 && !fits([...current, cert])) {
      pages.push({ format: POD_CERT_LOG_FORMAT, certs: current });
      current = [];
    }
    current.push(cert);
  }
  if (current.length > 0) pages.push({ format: POD_CERT_LOG_FORMAT, certs: current });
  return pages;
}

/**
 * The certificates on a page that genuinely carry `issuerPubkey`'s signature.
 *
 * Failures are DROPPED INDIVIDUALLY rather than voiding the page: a reader is
 * consuming bytes from a public address, and one unverifiable certificate must
 * not hide the holders alongside it. Returns empty for a page that is not a
 * well-formed log page at all.
 */
export function verifyPodCertLogPage(value: unknown, issuerPubkey: Hex32): PodCertV1[] {
  if (!validatePodCertLogPageV1(value)) return [];
  return value.certs.filter((c) => verifyPodCert(c, issuerPubkey));
}

/**
 * Distinct holder keys across pages, in first-seen order — the supply audit's
 * unit, and the enumeration a per-drop encryption publisher needs.
 *
 * DEDUPED BY HOLDER, because certificate count is not supply: an issuer
 * re-signs when a holder rotates keys or a date was wrong, and counting
 * certificates would inflate. Presence, not quantity, all the way through.
 */
export function holdersFromLogPages(pages: readonly PodCertV1[][]): Hex32[] {
  const seen = new Set<string>();
  const out: Hex32[] = [];
  for (const page of pages) {
    for (const cert of page) {
      if (seen.has(cert.holder)) continue;
      seen.add(cert.holder);
      out.push(cert.holder);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Log addressing — pure, because it is the highest-stakes arithmetic here
// ---------------------------------------------------------------------------

/** Where a page goes: a band, and a version inside it. */
export interface CertLogCursor {
  band: number;
  version: number;
}

/**
 * Where the NEXT page goes after `head`, or `{0,0}` for a log never written.
 *
 * The rollover case is the one worth stating: a head sitting at the last slot
 * of its band means the band is full, and a full band is an immutable fact — so
 * opening the next one is licensed by OBSERVATION, which is what the full-band
 * invariant requires. `>=` rather than `===` deliberately: an overshoot would
 * otherwise turn a transient loss of rollover into a permanent one.
 *
 * A `{0,0}` start is only safe when the caller RESOLVED the log absent cleanly —
 * this function cannot know that, and its caller must.
 */
export function firstCertLogCursor(head: CertLogCursor | null): CertLogCursor {
  if (!head) return { band: 0, version: 0 };
  if (head.version >= LAST_VERSION_IN_BAND) return { band: head.band + 1, version: 0 };
  return { band: head.band, version: head.version + 1 };
}

/**
 * Where the page after `written` goes, given `written` has been VERIFIED to
 * have landed. That verification is the observation the invariant needs when
 * this crosses a band boundary — which is why this takes the cursor just
 * written rather than a count.
 */
export function nextCertLogCursor(written: CertLogCursor): CertLogCursor {
  if (written.version >= LAST_VERSION_IN_BAND) return { band: written.band + 1, version: 0 };
  return { band: written.band, version: written.version + 1 };
}
