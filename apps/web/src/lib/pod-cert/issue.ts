/**
 * Issuing POD certificates — the issuer's write path (Gate B, slice 3).
 * Design record: docs/SWARM_SOCIAL_PLAN.md, BUILD RECORD slice 3.
 *
 * TREAT EVERY WRITE HERE AS DELIVERY, NOT AS AUDIT DÉCOR. Until the holder's
 * passport import exists, a certificate lives NOWHERE except this log — and
 * even afterwards, scanning the log is how a holder finds a certificate naming
 * them. So a write that is not verified to have landed is a certificate that
 * may simply not exist, which is why this path awaits its read-backs instead of
 * letting them settle in the background the way a lap does.
 *
 * BOTH SIGNATURES ARE THE ISSUER'S, AND NEITHER KEY CAN LIVE ON THE SERVER: the
 * certificate is signed by the creator's ed25519 POD key, and the SOC wrapper by
 * their secp256k1 content-feed signer. The server stamps and uploads chunks it
 * verifiably could not have authored — the same shape as credits, and what
 * keeps the log in the issuer's own address space rather than the platform's.
 */

import {
  LAST_VERSION_IN_BAND,
  POD_CERT_LOG_FORMAT,
  POD_CERT_SUBJECT_INDEX_FORMAT,
  holdersFromLogPages,
  packPodCertLogPages,
  planCertIssuance,
  podCertLogTopic,
  podCertPublicSalt,
  podCertSubjectIndexTopic,
  signPodCert,
  validatePodCertSubjectIndex,
  verifyPodCertLogPage,
  type Bytes32Hex,
  type Hex0x,
  type Hex32,
  type PodCertLogPageV1,
  type PodCertV1,
} from "@woco/shared";
import {
  readBandedContentFeed,
  readContentFeedAtVersion,
} from "../swarm/content-feed";
import { writeContentFeedVerified } from "../swarm/verified-write";

/** The issuer's two keys. Neither is ever sent anywhere. */
export interface CertIssuerKeys {
  /** ed25519 POD private key whose public half is the badge manifest's `issuerPubkey`. */
  podPrivKey: Uint8Array;
  issuerPubkey: Hex32;
  /** secp256k1 content-feed signer (sign-to-derive), and its address. */
  feedPrivKey: string;
  feedAddress: string;
}

export interface CertLogState {
  /** Distinct holders already certified, first-seen order. */
  holders: Hex32[];
  /** Head coordinates, or null when the log has never been written. */
  head: { band: number; version: number } | null;
  pagesRead: number;
}

export type CertLogReadResult =
  | ({ ok: true } & CertLogState)
  | { ok: false; error: string };

const salt = podCertPublicSalt();
const topicFor = (badge: Bytes32Hex) => (band: number) => podCertLogTopic(salt, badge, band);

/**
 * Read a badge's whole certificate log.
 *
 * THOROUGH THROUGHOUT, and not as caution: this read decides who is skipped as
 * already-certified, so a false absent re-issues duplicates, and a false absent
 * on the HEAD would start writing over versions that already hold someone's
 * certificate. A read that feeds a write decision may never take the gateway's
 * word for absence.
 *
 * The walk is all exact-address reads — every version below the head exists by
 * the full-band invariant — so it costs cheap hits and no missing-chunk
 * searches, which are the expensive read on Swarm.
 */
export async function readCertLog(
  ownerAddress: string,
  badge: Bytes32Hex,
  issuerPubkey: Hex32,
): Promise<CertLogReadResult> {
  const topic = topicFor(badge);
  const head = await readBandedContentFeed<PodCertLogPageV1>(ownerAddress, topic, { thorough: true });

  if (head.status === "unavailable" || !head.bandClean) {
    return { ok: false, error: "Could not read this badge's certificate log — try again." };
  }
  if (head.status === "absent") return { ok: true, holders: [], head: null, pagesRead: 0 };

  const pages: PodCertV1[][] = [];
  let pagesRead = 0;
  for (let band = 0; band <= head.band; band++) {
    const lastVersion = band < head.band ? LAST_VERSION_IN_BAND : head.version;
    for (let version = 0; version <= lastVersion; version++) {
      const page = await readContentFeedAtVersion<PodCertLogPageV1>(
        ownerAddress,
        topic(band),
        version,
        { thorough: true },
      );
      if (page.status === "unavailable") {
        // Refuse the whole run rather than plan against a partial holder list:
        // a holder missing from it is re-issued, and one missing near a cap is
        // an over-issue nothing downstream can catch.
        return { ok: false, error: `Could not read the log at band ${band} version ${version} — try again.` };
      }
      if (page.status === "absent") continue;
      pagesRead++;
      pages.push(verifyPodCertLogPage(page.value, issuerPubkey));
    }
  }

  return { ok: true, holders: holdersFromLogPages(pages), head: { band: head.band, version: head.version }, pagesRead };
}

export interface IssueRunResult {
  ok: boolean;
  /** Holders certified by THIS run, in the order their pages landed. */
  landed: Hex32[];
  /** Requested holders the log already carried. */
  alreadyHeld: Hex32[];
  pagesWritten: number;
  /** Set when the run stopped early. Everything in `landed` is still real. */
  error?: string;
}

/**
 * Certify holders of one badge.
 *
 * Resumable by construction: a crashed, closed-tab or double-clicked run leaves
 * a VERIFIED PREFIX — every landed certificate is real and complete, every
 * unlanded one simply was not issued — so re-running skips what already landed
 * and continues. That is also why the run stops at the first failed write
 * rather than pressing on: the next page's address is chained from this one's,
 * so continuing past an unverified write would guess at a version.
 */
export async function issueCertificates(args: {
  badge: Bytes32Hex;
  keys: CertIssuerKeys;
  holders: readonly Hex32[];
  /** The manifest's `totalSupply`. Omit only when genuinely unknown. */
  cap?: number;
  /** UTC `YYYY-MM-DD`; defaults to today. Self-declared and unverifiable. */
  issuedAt?: string;
  /** Optional per-holder extras, keyed by holder. */
  extras?: Record<string, { encPubKey?: Hex32; evidence?: string[] }>;
  onProgress?: (done: number, total: number) => void;
}): Promise<IssueRunResult> {
  const { badge, keys } = args;
  const empty = { landed: [] as Hex32[], alreadyHeld: [] as Hex32[], pagesWritten: 0 };

  const log = await readCertLog(keys.feedAddress, badge, keys.issuerPubkey);
  if (!log.ok) return { ok: false, ...empty, error: log.error };

  const plan = planCertIssuance({
    requested: args.holders,
    existingHolders: log.holders,
    ...(args.cap != null ? { cap: args.cap } : {}),
  });
  if (!plan.ok) return { ok: false, ...empty, error: plan.error };
  if (plan.toIssue.length === 0) {
    return { ok: true, landed: [], alreadyHeld: plan.alreadyHeld, pagesWritten: 0 };
  }

  const issuedAt = args.issuedAt ?? new Date().toISOString().slice(0, 10);
  let certs: PodCertV1[];
  try {
    certs = plan.toIssue.map((holder) => {
      const extra = args.extras?.[holder] ?? {};
      return signPodCert(
        {
          format: "woco.pod-cert.v1",
          badge,
          holder,
          issuedAt,
          ...(extra.encPubKey ? { encPubKey: extra.encPubKey } : {}),
          ...(extra.evidence?.length ? { evidence: extra.evidence } : {}),
        },
        keys.podPrivKey,
        keys.issuerPubkey,
      );
    });
  } catch (e) {
    return { ok: false, ...empty, alreadyHeld: plan.alreadyHeld, error: e instanceof Error ? e.message : "Could not sign." };
  }

  const pages = packPodCertLogPages(certs);
  const topic = topicFor(badge);
  const landed: Hex32[] = [];
  let pagesWritten = 0;

  // Where the first page goes. An absent log starts at band 0 version 0, which
  // is the ONLY probing write on this path and is safe precisely because the
  // resolution above came back clean-absent.
  let band = log.head?.band ?? 0;
  let version = log.head ? log.head.version + 1 : 0;
  if (log.head && log.head.version >= LAST_VERSION_IN_BAND) {
    // The full-band invariant: a band may only be opened having OBSERVED the one
    // below it full. A clean head sitting at the last slot is that observation.
    band += 1;
    version = 0;
  }

  for (const page of pages) {
    const written = await writeContentFeedVerified({
      signerPrivKey: keys.feedPrivKey,
      ownerAddress: keys.feedAddress,
      topic: topic(band),
      data: page,
      knownVersion: version,
    });

    if (written.status !== "verified") {
      return {
        ok: false,
        landed,
        alreadyHeld: plan.alreadyHeld,
        pagesWritten,
        error:
          written.status === "superseded"
            ? "Another device is issuing certificates for this badge right now — re-run to continue."
            : "A certificate page could not be confirmed. Re-run to continue where this left off.",
      };
    }

    pagesWritten++;
    for (const c of page.certs) landed.push(c.holder);
    args.onProgress?.(landed.length, certs.length);

    // Chain the next address from THIS verified write, never from a guess.
    if (version >= LAST_VERSION_IN_BAND) {
      band += 1;
      version = 0;
    } else {
      version += 1;
    }
  }

  // The issuer's own index of badges they have certified. Best-effort by design:
  // it must never fail a certificate that has already landed, and no third party
  // needs it — a reader derives the log topic from the badge itself.
  await upsertCertifiedBadge(keys, badge, band).catch(() => {});

  return { ok: true, landed, alreadyHeld: plan.alreadyHeld, pagesWritten };
}

/**
 * Record `badge` in the issuer's subject index at `band`.
 *
 * A READ-MODIFY-WRITE of a whole snapshot, so it REFUSES on an inconclusive
 * read rather than proceeding: its writer probes for a fresh address
 * independently of what we read, so a stale snapshot lands at the real latest
 * version, verifies, and erases every badge added since — with nothing
 * detecting it. The opposite of the page writes above, which are exact-address
 * and guarded by their own read-back.
 */
async function upsertCertifiedBadge(
  keys: CertIssuerKeys,
  badge: Bytes32Hex,
  band: number,
): Promise<boolean> {
  const indexTopic = (b: number) => podCertSubjectIndexTopic(salt, b);
  const existing = await readBandedContentFeed<unknown>(keys.feedAddress, indexTopic, { thorough: true });
  if (existing.status === "unavailable" || !existing.bandClean) return false;

  const current =
    existing.status === "found" && validatePodCertSubjectIndex(existing.value)
      ? existing.value.entries
      : [];
  const found = current.find((e) => e.subject.toLowerCase() === badge.toLowerCase());
  if (found && found.band >= band) return true;

  const merged = found
    ? current.map((e) =>
        e.subject.toLowerCase() === badge.toLowerCase()
          ? { subject: e.subject, band: Math.max(e.band, band) }
          : e,
      )
    : [...current, { subject: badge as Hex0x, band }];

  // `>=`, not `===` — an overshoot would otherwise turn a transient loss of
  // rollover into a permanent one.
  const rollover = existing.status === "found" && existing.version >= LAST_VERSION_IN_BAND;
  const targetBand = rollover ? existing.band + 1 : existing.band;

  const written = await writeContentFeedVerified({
    signerPrivKey: keys.feedPrivKey,
    ownerAddress: keys.feedAddress,
    topic: indexTopic(targetBand),
    data: { format: POD_CERT_SUBJECT_INDEX_FORMAT, entries: merged },
  });
  return written.status === "verified";
}

/** Re-exported so callers do not reach past this module for the log format. */
export { POD_CERT_LOG_FORMAT };
