/**
 * What an indexer PUBLISHES, as distinct from what it computes.
 *
 * A tally is served on request today, which means the count exists only while
 * our server does (`SWARM_SOCIAL_PLAN` P1.5, commitments 4 and 6). A report is
 * the same evidence written to a Swarm feed the indexer owns, at an address
 * derived from the subject, so a reader can recount it without asking anyone.
 *
 * THE DETERMINISM SPLIT, which is the whole reason this is a wrapper and not
 * three more manifest fields. `tally.ts` promises that two indexers with the
 * same inputs publish byte-identical manifests, and that promise is what makes
 * two indexers' answers comparable at all. So the split is by kind of fact:
 *
 *   inner manifest  — a deterministic function of the input set
 *   wrapper         — circumstances of THIS indexer's run
 *
 * Which feeds an indexer failed to read, and when it happened to publish, are
 * facts about a run: two honest indexers will legitimately differ on both. Put
 * either inside the manifest and manifests stop being comparable, quietly. If
 * you are here to add a timestamp because a reader could not tell how stale a
 * count was, add it to the WRAPPER.
 *
 * `publishedAt` is SELF-DECLARED and unverifiable. Nothing timestamps a Swarm
 * write, so this is the indexer's own claim about when it published, and a
 * reader should treat it as such — it is useful for "this is hours old", never
 * as proof of when anything happened.
 *
 * NO SIGNATURE FIELD, and that is deliberate. The report is stored as a
 * single-owner chunk, so the SOC's own signature already binds these exact
 * bytes to the indexer's key at this exact topic and version — the same
 * reasoning that gives a like no identity signature (`discipline.ts`: the
 * author IS the feed owner). The consequence to remember when moving reports
 * around: the signature lives in the CHUNK, so anything mirroring a report must
 * carry raw chunk bytes, never re-serialised JSON.
 *
 * VIEW PLANE, deliberately not frozen. The statement discipline is frozen
 * because statements are signed by users and live forever at computed
 * addresses. A report is recomputable at will by anyone holding the participant
 * list, so a v2 that supersedes this shape costs a republish, not a migration.
 */

import { utf8ToBytes } from "@noble/hashes/utils.js";
import { statementTopic, subjectToBytes } from "./discipline.js";
import { EVIDENCE_MANIFEST_FORMAT, type EvidenceManifestV1 } from "./tally.js";
import type { Hex0x } from "../types.js";

export const EVIDENCE_REPORT_FORMAT = "woco.evidence-report.v1" as const;

/**
 * The indexer a client reads by default — WoCo's.
 *
 * It names whose claim you are reading, not an authority. Every indexer
 * publishes at the same topic inside its OWN address space, so pointing a
 * reader at a different address reads a different indexer's report of the same
 * subject, with no coordination and no permission. That is the plan's
 * "permissionless by design" written as an address.
 *
 * Public by nature (it is a feed owner, derived from `SOCIAL_INDEXER_PRIVATE_KEY`
 * on the server). Changing it orphans no data worth keeping: a report is
 * recomputable from the participants it names.
 */
export const SOCIAL_INDEXER_ADDRESS = "0x4a505197954dd70ed833d98a4e225460d84caebf" as Hex0x;

/** Topic-scheme type name (`[a-z0-9-]+`) — distinct from the dotted format id. */
const EVIDENCE_REPORT_TYPE = "evidence-report";
const EVIDENCE_REPORT_VERSION = 1;

/**
 * Where an indexer's report for one subject lives:
 * `"woco/evidence-report/v1/" + hex(HMAC-SHA256(salt, subjectBytes))`, with the
 * salt folding in the statement format being tallied.
 *
 * The statement format has to be in the SALT rather than assumed, because the
 * same subject can be liked, followed and ridden. One topic for all three would
 * put three unrelated counts at one address, where each write would overwrite
 * the last and the feed would read as a single number flickering between them.
 *
 * THE SAME TOPIC STRING FOR EVERY INDEXER. Feeds resolve inside an owner's
 * address space (`chunk address = keccak256(identifier || owner)`), so a second
 * indexer publishing the same subject writes to a different chunk without any
 * coordination — differentiation is by WHOSE report you chose to read, which is
 * the permissionless-indexer model stated as an address. A per-indexer topic
 * would add nothing and make a third party's reports unfindable.
 *
 * Built on the frozen topic primitives on purpose: this is view-plane data, but
 * an encoding that drifts from the statement scheme is an encoding somebody has
 * to re-derive by reading our source.
 */
export function evidenceReportTopic(statementFormat: string, subject: Hex0x): string {
  const salt = utf8ToBytes(`woco-${EVIDENCE_REPORT_TYPE}-public-v${EVIDENCE_REPORT_VERSION}-${statementFormat}`);
  // Band 0 always. An evidence report is the indexer's own latest-wins statement
  // about one subject, so its feed gains a version per REPUBLISH, not per event
  // it describes — it has no growth axis to bound. It rides the banded scheme
  // (band 0) rather than opting out, because the topic derivation is uniform.
  return statementTopic(EVIDENCE_REPORT_TYPE, EVIDENCE_REPORT_VERSION, salt, subjectToBytes(subject), 0);
}

/**
 * A published report: the manifest, plus what qualifies it.
 *
 * The qualifiers travel WITH it because a reader who has to make a second
 * request for "is this count complete?" will not make it, and will publish a
 * floor as a total (the same reason `/api/social/manifest` serves them inline).
 * That reasoning is stronger here, not weaker: a report is read precisely when
 * the indexer cannot be asked anything.
 */
export interface EvidenceReportV1<L> {
  format: typeof EVIDENCE_REPORT_FORMAT;
  /** Byte-for-byte what the tally produced — see the determinism split above. */
  manifest: EvidenceManifestV1<L>;
  /**
   * Feed owners this pass could not READ — distinct from read-and-silent. The
   * count is then a floor, and must never be shown as a finished total.
   */
  unreadable: string[];
  /**
   * Holders who signed two different statements at one point in their own
   * history. Surfaced, never smoothed. Empty for the boolean families: a SOC
   * version cannot fork, so a single feed cannot equivocate with itself.
   */
  equivocations: string[];
  /** The indexer's own claim of when it published. Milliseconds since epoch. */
  publishedAt: number;
}

const OWNER_RE = /^0x[0-9a-f]{40}$/;
/** A holder key is a bare 32-byte ed25519 public key in lowercase hex. */
const HOLDER_RE = /^[0-9a-f]{64}$/;
const SUBJECT_RE = /^0x[0-9a-f]{64}$/;

function isCount(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

function stringList(v: unknown, re: RegExp): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string" || !re.test(item)) return null;
    out.push(item);
  }
  return out;
}

/**
 * Build a report. The manifest is passed through untouched — a builder that
 * "normalised" it would be editing the one part that has to stay byte-identical
 * to what an honest second indexer produces.
 */
export function evidenceReport<L>(args: {
  manifest: EvidenceManifestV1<L>;
  unreadable: readonly string[];
  equivocations: readonly string[];
  publishedAt: number;
}): EvidenceReportV1<L> {
  return {
    format: EVIDENCE_REPORT_FORMAT,
    manifest: args.manifest,
    unreadable: [...args.unreadable],
    equivocations: [...args.equivocations],
    publishedAt: args.publishedAt,
  };
}

/**
 * Parse a report read from Swarm, refusing anything it cannot fully account for.
 *
 * All-or-nothing, for the same reason the verification page is: a leaf whose
 * `total` arrived as a string would make a recount CONCATENATE — "1" + "9"
 * renders as a confident 19 — and a number nobody understood is worse than an
 * honest "could not read this", since being recomputable is the only reason to
 * believe any of it.
 *
 * `parseLeaf` is injected because the two tally families carry different leaves
 * and their parsers already exist at the surfaces that read them; duplicating
 * one here would be a second definition of what a valid leaf is.
 *
 * Note what this does NOT do: it does not check the manifest against a subject
 * you asked for. A report for another subject is a real answer to a different
 * question, so the CALLER — which knows what it asked — compares.
 */
export function parseEvidenceReportV1<L>(
  value: unknown,
  parseLeaf: (leaf: unknown) => L | null,
): EvidenceReportV1<L> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;

  // Closed schema, by exact key set: an unexpected key means this is not the
  // shape we think it is, and it also makes the paging marker (`_woco_mc`)
  // unrepresentable here.
  const keys = Object.keys(o).sort();
  if (keys.length !== 5) return null;
  if (keys[0] !== "equivocations" || keys[1] !== "format" || keys[2] !== "manifest") return null;
  if (keys[3] !== "publishedAt" || keys[4] !== "unreadable") return null;

  if (o.format !== EVIDENCE_REPORT_FORMAT) return null;
  if (!isCount(o.publishedAt)) return null;

  const unreadable = stringList(o.unreadable, OWNER_RE);
  const equivocations = stringList(o.equivocations, HOLDER_RE);
  if (unreadable === null || equivocations === null) return null;

  const manifest = parseManifest(o.manifest, parseLeaf);
  if (manifest === null) return null;

  return { format: EVIDENCE_REPORT_FORMAT, manifest, unreadable, equivocations, publishedAt: o.publishedAt };
}

function parseManifest<L>(value: unknown, parseLeaf: (leaf: unknown) => L | null): EvidenceManifestV1<L> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const m = value as Record<string, unknown>;

  const keys = Object.keys(m).sort();
  if (keys.length !== 6) return null;
  if (keys[0] !== "count" || keys[1] !== "format" || keys[2] !== "leaves") return null;
  if (keys[3] !== "participants" || keys[4] !== "statementFormat" || keys[5] !== "subject") return null;

  if (m.format !== EVIDENCE_MANIFEST_FORMAT) return null;
  if (typeof m.statementFormat !== "string" || m.statementFormat.length === 0) return null;
  if (typeof m.subject !== "string" || !SUBJECT_RE.test(m.subject)) return null;
  if (!isCount(m.count)) return null;

  const participants = stringList(m.participants, OWNER_RE);
  if (participants === null) return null;
  if (!Array.isArray(m.leaves)) return null;

  const leaves: L[] = [];
  for (const raw of m.leaves) {
    const leaf = parseLeaf(raw);
    if (leaf === null) return null;
    leaves.push(leaf);
  }

  return {
    format: EVIDENCE_MANIFEST_FORMAT,
    statementFormat: m.statementFormat,
    subject: m.subject as Hex0x,
    participants: participants as Hex0x[],
    leaves,
    count: m.count,
  };
}
