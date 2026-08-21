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
  firstCertLogCursor,
  holdersFromLogPages,
  nextCertLogCursor,
  packPodCertLogPages,
  planCertIssuance,
  podCertLogTopic,
  podCertPublicSalt,
  podCertSubjectIndexTopic,
  resolvePodCertIssuer,
  signPodCert,
  validatePodCertLogPageV1,
  validatePodCertSubjectIndex,
  verifyPodCertLogPage,
  type Bytes32Hex,
  type CertLogCursor,
  type Hex0x,
  type Hex32,
  type PodCertLogPageV1,
  type PodCertV1,
  type SeriesManifestBlob,
  type SignedManifestV1,
} from "@woco/shared";
import {
  readBandedContentFeed,
  readContentFeedAtVersion,
} from "../swarm/content-feed";
import { WOCO_GATEWAY_URL } from "../swarm/gateways";
import { writeContentFeedVerified } from "../swarm/verified-write";
import { contentFeedSignerFromPrivKey } from "../swarm/content-feed";

/**
 * The issuer's two keys. Neither is ever sent anywhere.
 *
 * NOTE WHAT IS ABSENT: there is no `issuerPubkey`. The badge's issuer key is
 * resolved from its MANIFEST, which binds it to the badge by digest — so this
 * call cannot be handed the wrong one, because it does not take one. Same move
 * as `podCertHoldingFromManifest`, and for the same reason: an issuer key that
 * merely type-checks is exactly what `PodDirectoryEntry.issuer` is, and that
 * field is an unverified display mirror sitting one import away.
 */
export interface CertIssuerKeys {
  /** ed25519 POD private key. Its public half MUST be the manifest's `issuerPubkey`. */
  podPrivKey: Uint8Array;
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
 * Per-holder extras, looked up CASE-INSENSITIVELY.
 *
 * A plain `extras[holder]` is a dropped-parameter waiting to happen: holder keys
 * are lowercase hex by schema, but an extras map assembled from a paste, a CSV
 * or a different normalisation would miss silently, and the certificate that
 * loses its `encPubKey` is written permanently. The orphan check in
 * `issueCertificates` and this lookup MUST agree on the comparison, which is
 * why both live here rather than being spelled out twice.
 */
function extrasFor(
  extras: Record<string, { encPubKey?: Hex32; evidence?: string[] }> | undefined,
  holder: Hex32,
): { encPubKey?: Hex32; evidence?: string[] } {
  if (!extras) return {};
  const direct = extras[holder];
  if (direct) return direct;
  const wanted = holder.toLowerCase();
  for (const [k, v] of Object.entries(extras)) if (k.toLowerCase() === wanted) return v;
  return {};
}

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
  /**
   * The badge's signed manifest — NOT an issuer key. `resolvePodCertIssuer`
   * recomputes `keccak256(dagCbor(body))` and returns the issuer key only if it
   * equals `badge`, so the key used to verify this log is bound to the badge by
   * a digest rather than by whoever passed it.
   *
   * A wrong key here is not a read error, it is a SILENT one: every certificate
   * on the log fails verification, the log reads as holding nobody, and the
   * caller then plans to re-issue every holder it already has.
   */
  manifest: SignedManifestV1,
): Promise<CertLogReadResult> {
  const issuerPubkey = resolvePodCertIssuer(manifest, badge);
  if (!issuerPubkey) {
    return {
      ok: false,
      error: "This manifest is not this badge's — refusing to read its log against an unbound issuer key.",
    };
  }
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
      // EVERY VERSION BELOW A CLEAN HEAD EXISTS, by construction: pages are
      // written sequentially, each verified before the cursor advances, and a
      // band opens only on observed fullness. So `absent` here is not "nothing
      // was written", it is a CONTRADICTION — and a reachable one, because even
      // a thorough probe's absent ultimately rests on a not-found, and
      // `readSocPayload` maps a bee 500 to exactly that.
      //
      // Skipping it would plan against a partial holder list: every holder on
      // the unseen page is re-issued as a duplicate, and near the cap it admits
      // holders past `totalSupply` — a log full at 100 with one hidden 7-holder
      // page reads as 93, so a 5-holder request passes the plan and lands 105.
      // Nothing downstream can catch that; the audit later reads the page fine
      // and simply shows the over-issue. Refuse, like its `unavailable` sibling.
      if (page.status !== "found") {
        return {
          ok: false,
          error: `Could not read the log at band ${band} version ${version} — try again.`,
        };
      }
      // Same contradiction class: a page in our own log below our own head that
      // does not even parse as a page. Folding it to "no certificates here"
      // under-counts exactly as silently.
      if (!validatePodCertLogPageV1(page.value)) {
        return {
          ok: false,
          error: `The log page at band ${band} version ${version} is not readable — refusing to issue against a partial list.`,
        };
      }
      pagesRead++;
      // Per-CERTIFICATE signature failures are still dropped individually: one
      // bad certificate must not hide the holders alongside it.
      pages.push(verifyPodCertLogPage(page.value, issuerPubkey));
    }
  }

  return { ok: true, holders: holdersFromLogPages(pages), head: { band: head.band, version: head.version }, pagesRead };
}

/**
 * WHY a run stopped, machine-readable.
 *
 * The three cases need three different responses from an operator and MUST NOT
 * be told apart by matching on `error` prose — a surface that string-matches is
 * one copy-edit away from silently treating the forbidden case as the benign
 * one, and the forbidden case here writes to permanent addresses.
 *
 * - `refused`  — nothing was written and nothing will be until the input
 *                changes. Safe to correct and re-run.
 * - `superseded` — a version this run targeted already held different bytes.
 *                On a single-device run that means the address arithmetic
 *                pointed at an occupied version: STOP, investigate, do not
 *                re-run. This code cannot tell that case from a genuine second
 *                device, so it never advises retrying.
 * - `unconfirmed` — the write was accepted but could not be confirmed. Not a
 *                failure; not a success either. The only safe next step is a
 *                READ, never another write.
 */
export type IssueRunStop = "refused" | "superseded" | "unconfirmed";

export interface IssueRunResult {
  ok: boolean;
  /** Holders certified by THIS run, in the order their pages landed. */
  landed: Hex32[];
  /** Requested holders the log already carried. */
  alreadyHeld: Hex32[];
  pagesWritten: number;
  /** Set when the run stopped early. Everything in `landed` is still real. */
  error?: string;
  /** Set with `error`. Branch on THIS, never on the message. */
  stop?: IssueRunStop;
  /** Where the failing write was aimed — the diagnostic a `superseded` needs. */
  stoppedAt?: CertLogCursor;
}

/** Inputs `precheckIssuance` needs — the subset of an issuance run that can be
 *  judged with no I/O beyond deriving an address from a private key. */
export interface IssuancePrecheckArgs {
  badge: Bytes32Hex;
  keys: CertIssuerKeys;
  holders: readonly Hex32[];
  manifest: SignedManifestV1;
  expectedLogOwner: Hex0x;
  extras?: Record<string, { encPubKey?: Hex32; evidence?: string[] }>;
}

export type IssuancePrecheck =
  | { ok: true; issuerPubkey: Hex32 }
  | { ok: false; error: string };

/**
 * Everything that can be refused BEFORE a byte is read or written.
 *
 * Split out for the same reason `planCertIssuance` is: the decisions here are
 * the part most worth testing, and the orchestration around them needs a
 * browser and a gateway. Every failure below is otherwise SILENT — not an
 * exception, not a bad status, but a run that looks like it worked while
 * writing permanent bytes to the wrong address or under the wrong key.
 *
 * Returns the resolved issuer key on success, so the caller cannot go on to use
 * a different one than the one just proved.
 */
export async function precheckIssuance(args: IssuancePrecheckArgs): Promise<IssuancePrecheck> {
  // The issuer key comes from the MANIFEST, bound to the badge by digest. This
  // catches the nastiest case on this path: a POD keypair that agrees with
  // ITSELF but is not this badge's issuer. `signPodCert` would happily sign —
  // its own check only compares the private key against the public half it was
  // handed — the log read would drop every existing certificate as
  // unverifiable, the plan would re-issue every holder already certified, and
  // the duplicates would land permanently against the cap, signed by a key that
  // verifies against nothing at any door.
  const issuerPubkey = resolvePodCertIssuer(args.manifest, args.badge);
  if (!issuerPubkey) {
    return { ok: false, error: "This manifest is not this badge's — refusing to issue against an unbound issuer key." };
  }

  // The log lives at `keccak256(identifier ‖ owner)`. A wrong owner is not an
  // error anywhere: it is a clean, empty, PARALLEL log at an address no reader
  // will ever look at — indistinguishable from a first issuance, and permanent.
  if (args.keys.feedAddress.toLowerCase() !== args.expectedLogOwner.toLowerCase()) {
    return {
      ok: false,
      error:
        "This device's feed signer is not the address this badge's certificate log was published under — refusing to write a second log nobody will read.",
    };
  }

  // ...and `feedAddress` must actually BE `feedPrivKey`'s address, or the
  // read-back verifies a feed we did not write. That surfaces as `unconfirmed`:
  // late, and mislabelled as a gateway problem.
  const derived = await contentFeedSignerFromPrivKey(args.keys.feedPrivKey).catch(() => null);
  if (!derived || derived.address.toLowerCase() !== args.keys.feedAddress.toLowerCase()) {
    return { ok: false, error: "The feed signing key and its address disagree — refusing to write." };
  }

  // An extras entry keyed to nobody in this run is a DROPPED PARAMETER: the
  // `encPubKey` or `evidence` it carried never reaches a certificate, and the
  // certificate is permanent. Refuse rather than silently omit. Matched the
  // same way `extrasFor` matches, or a key could pass here and still be lost.
  if (args.extras) {
    const requested = new Set(args.holders.map((h) => h.toLowerCase()));
    const orphan = Object.keys(args.extras).find((k) => !requested.has(k.toLowerCase()));
    if (orphan) {
      return { ok: false, error: `Extra data was supplied for ${orphan.slice(0, 12)}…, who is not in this run.` };
    }
  }

  return { ok: true, issuerPubkey };
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
  /**
   * The badge's signed manifest. REQUIRED, and it carries THREE things this
   * call refuses to be told separately:
   *
   * 1. the ISSUER KEY, resolved by digest so it is bound to `badge`;
   * 2. the CAP — `body.totalSupply`, which is why there is no `cap` parameter
   *    any more. Slice 3 made a cap required so it could not be forgotten;
   *    taking it from the manifest means it also cannot be WRONG. The obvious
   *    thing a caller would otherwise pass is `PodDirectoryEntry.supply`, which
   *    is mutable display state;
   * 3. proof that 1 and 2 belong to the same badge as everything else here.
   */
  manifest: SignedManifestV1;
  /**
   * Where the directory says this badge's log lives — `PodDirectoryEntry.certLogOwner`.
   *
   * REQUIRED because the failure it catches is otherwise perfectly silent: a
   * run whose `keys.feedAddress` is not the recorded owner reads a DIFFERENT
   * (empty) address space, resolves clean-absent, re-issues every holder, and
   * writes a parallel log at an address no reader will ever look at. Split-view
   * by accident, permanent, and indistinguishable from a first issuance.
   */
  expectedLogOwner: Hex0x;
  /** UTC `YYYY-MM-DD`; defaults to today. Self-declared and unverifiable. */
  issuedAt?: string;
  /** Optional per-holder extras, keyed by holder. */
  extras?: Record<string, { encPubKey?: Hex32; evidence?: string[] }>;
  onProgress?: (done: number, total: number) => void;
}): Promise<IssueRunResult> {
  const { badge, keys } = args;
  const empty = { landed: [] as Hex32[], alreadyHeld: [] as Hex32[], pagesWritten: 0 };
  const refuse = (error: string): IssueRunResult => ({ ok: false, ...empty, error, stop: "refused" });

  const pre = await precheckIssuance(args);
  if (!pre.ok) return refuse(pre.error);
  const { issuerPubkey } = pre;

  const log = await readCertLog(keys.feedAddress, badge, args.manifest);
  if (!log.ok) return { ok: false, ...empty, error: log.error, stop: "refused" };

  const plan = planCertIssuance({
    requested: args.holders,
    existingHolders: log.holders,
    // The CAP, from the signed manifest — never from mutable display state.
    cap: args.manifest.body.totalSupply,
  });
  if (!plan.ok) return refuse(plan.error);
  if (plan.toIssue.length === 0) {
    return { ok: true, landed: [], alreadyHeld: plan.alreadyHeld, pagesWritten: 0 };
  }

  const issuedAt = args.issuedAt ?? new Date().toISOString().slice(0, 10);
  let certs: PodCertV1[];
  try {
    certs = plan.toIssue.map((holder) => {
      // Matched the same way the orphan check above matched, or a
      // case-mismatched key would pass validation and still be dropped here.
      const extra = extrasFor(args.extras, holder);
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
        issuerPubkey,
      );
    });
  } catch (e) {
    return {
      ok: false,
      ...empty,
      alreadyHeld: plan.alreadyHeld,
      error: e instanceof Error ? e.message : "Could not sign.",
      stop: "refused",
    };
  }

  const pages = packPodCertLogPages(certs);
  const topic = topicFor(badge);
  const landed: Hex32[] = [];
  let pagesWritten = 0;

  // Where the first page goes. An absent log starts at band 0 version 0, which
  // is the ONLY probing write on this path and is safe precisely because the
  // resolution above came back clean-absent. The arithmetic itself is pure and
  // tested in shared — it is the highest-stakes arithmetic on this path, and a
  // mid-run rollover needs ~450 holders to occur naturally, so it would
  // otherwise go unexercised for months.
  let cursor: CertLogCursor = firstCertLogCursor(log.head);
  let lastWritten: CertLogCursor | null = null;

  for (const page of pages) {
    const written = await writeContentFeedVerified({
      signerPrivKey: keys.feedPrivKey,
      ownerAddress: keys.feedAddress,
      topic: topic(cursor.band),
      data: page,
      knownVersion: cursor.version,
    });

    if (written.status !== "verified") {
      // NEITHER message advises a retry, and that is deliberate.
      //
      // `superseded` means this exact version already held DIFFERENT bytes. On a
      // single-device run that can only mean the address arithmetic aimed at an
      // occupied version — and re-running would compound it at permanent
      // addresses. Nothing here can distinguish that from a genuine second
      // device, so the honest answer is to stop and say both, and to leave the
      // guidance to a surface that knows what the operator is doing. The
      // recovery for a real concurrent device is to start the flow again from
      // the badge, which re-reads the whole log thoroughly — not a "continue".
      //
      // `unconfirmed` is not a failure and not a success: the safe next step is
      // a READ, never another write.
      return {
        ok: false,
        landed,
        alreadyHeld: plan.alreadyHeld,
        pagesWritten,
        stop: written.status === "superseded" ? "superseded" : "unconfirmed",
        stoppedAt: cursor,
        error:
          written.status === "superseded"
            ? `This version of the log (band ${cursor.band}, version ${cursor.version}) already holds different bytes.`
            : `A certificate page at band ${cursor.band}, version ${cursor.version} could not be confirmed.`,
      };
    }

    pagesWritten++;
    lastWritten = cursor;
    for (const c of page.certs) landed.push(c.holder);
    args.onProgress?.(landed.length, certs.length);

    // Chain the next address from THIS verified write, never from a guess.
    cursor = nextCertLogCursor(cursor);
  }

  // The issuer's own index of badges they have certified. Best-effort by design:
  // it must never fail a certificate that has already landed, and no third party
  // needs it — a reader derives the log topic from the badge itself.
  // The band of the last page WRITTEN, never the cursor — a run whose final page
  // lands at the last slot leaves the cursor pointing at a band with no opener,
  // and recording that would make every future reader restart from 0 AND tick
  // `hintInvalidated`, which is the whitelist-lag alarm. A code path that
  // manufactures false positives on a monitored alarm is worth two lines.
  if (lastWritten) await upsertCertifiedBadge(keys, badge, lastWritten.band).catch(() => {});

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

  // The lenient-read-on-a-write-path trap, refused the way `social.ts` refuses
  // it: falling through to an empty list would write a fresh index containing
  // only this badge and ERASE every prior entry. Reachable via a future format
  // bump read by an older client.
  if (existing.status === "found" && !validatePodCertSubjectIndex(existing.value)) return false;
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


// ---------------------------------------------------------------------------
// Fetching the badge's manifest — the trust root every read and write here uses
// ---------------------------------------------------------------------------

export type BadgeManifestResult =
  | { ok: true; manifest: SignedManifestV1 }
  | { ok: false; error: string };

/**
 * Load and verify the manifest for `badge` from `swarmManifestRef`.
 *
 * Returns a REASON rather than null, because the caller is a surface an
 * organiser is looking at and "could not read it" and "that is not this badge's
 * manifest" call for different actions — one is a retry, the other never will
 * be.
 */
export async function loadBadgeManifest(
  swarmManifestRef: string,
  badge: Bytes32Hex,
  gatewayUrl: string = WOCO_GATEWAY_URL,
): Promise<BadgeManifestResult> {
  let blob: SeriesManifestBlob;
  try {
    const res = await fetch(`${gatewayUrl}/bytes/${swarmManifestRef}`);
    if (!res.ok) return { ok: false, error: "Could not read this badge's manifest — try again." };
    blob = (await res.json()) as SeriesManifestBlob;
  } catch {
    return { ok: false, error: "Could not read this badge's manifest — try again." };
  }

  const manifest = blob?.signedManifest;
  if (!manifest) {
    return { ok: false, error: "Could not read this badge's manifest — try again." };
  }
  // The binding, re-proved: digest must equal the badge, and the signature must
  // be the issuer's. Permanent failure, not a retry.
  if (!resolvePodCertIssuer(manifest, badge)) {
    return {
      ok: false,
      error: "The stored manifest does not match this badge — it cannot be used to award it.",
    };
  }
  return { ok: true, manifest };
}

/** Re-exported so callers do not reach past this module for the log format. */
export { POD_CERT_LOG_FORMAT };
