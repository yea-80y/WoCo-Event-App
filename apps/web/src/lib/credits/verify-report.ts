/**
 * The verification page's data layer: ask an indexer for its published working,
 * then add it up here, in the reader's own browser.
 *
 * This is the reader's side of `SWARM_SOCIAL_PLAN` commitment 4.
 *
 * WHAT THE RECOUNT ESTABLISHES, stated here so the UI cannot quietly overclaim
 * it. `/api/social/manifest` already recounts server-side and returns 500
 * rather than serve a manifest failing its own arithmetic, so recounting here
 * cannot catch OUR live server lying — it catches a corrupted or stale
 * intermediary, a manifest from somebody else's indexer, and it makes "your
 * machine did the adding up" literally true rather than a figure of speech.
 * That is worth having and it is not the same as verification, so the copy says
 * "recounted", never "verified".
 *
 * A carried-total leaf carries `{holder, feedOwner, seq, version, digest,
 * total}` — not the rider's signed statement. So adding leaves up proves the
 * published number is the number the published evidence supports, and nothing
 * about signatures. `version` is what makes the heavier check possible: with it
 * a reader can derive the chunk address and go and read the record itself.
 *
 * ONE REQUEST, deliberately. `/count` and `/manifest` are served from the same
 * 30-second cache entry, so fetching both to compare them cannot detect
 * dishonesty — it can only manufacture a scary disagreement when a lap lands
 * between two fetches across a cache boundary. `/count` stays the endpoint for
 * a widget or an overlay, where a bare number is the product.
 *
 * THE SOURCE IS A SEAM. Nothing above `buildReport` knows this arrived over
 * HTTP: it is pure over an `Evidence`, so a manifest published to Swarm (P1.5)
 * or a tally compiled in the browser from a Swarm-read participant list (P3)
 * feeds the same path. The server is a SOURCE here, never the authority.
 */

import {
  recountManifest,
  lookupSubject,
  currentEra,
  formerNames,
  WOCO_SUBJECTS,
  type SubjectCatalogue,
  type CarriedEvidenceLeaf,
  type EvidenceManifestV1,
  type Hex0x,
} from "@woco/shared";

/** The only statement format this page reads. Laps, not likes: the two tally
 *  families need different explanations of what their evidence proves, and one
 *  surface saying both would confuse or, saying neither, mislead. */
export const CREDIT_FORMAT = "woco.credit.v1";

const SUBJECT_RE = /^0x[0-9a-f]{64}$/;
const HOLDER_RE = /^[0-9a-f]{64}$/;
const OWNER_RE = /^0x[0-9a-f]{40}$/;
const DIGEST_RE = /^0x[0-9a-f]{64}$/;

/**
 * Riders whose OWN lifetime count is the headline for a subject, by subject
 * hash. Empty, and that is the honest state.
 *
 * A challenge counter and a community counter are different numbers over the
 * same evidence: `manifest.count` is the SUM of every rider's total for the
 * coaster, so the moment a second rider publishes a Rita count, a page
 * headlining the sum stops meaning "one rider's laps" while still looking
 * exactly the same. A challenge headline therefore has to name whose laps it
 * is, and naming needs the rider's holder key — which nothing publishes yet.
 *
 * So the mechanism ships and the entry does not. Adding one line here turns
 * this into a challenge counter; inventing a key to fill it in would be a
 * number attributed to a person on our say-so.
 *
 * Note when it does arrive: the key-to-person link is an ANNOUNCEMENT, not
 * mathematics. The signature proves the holder identity signed; that this
 * identity is a given rider is something their team said. The copy must not
 * blur the two.
 */
export const FEATURED_HOLDERS: Readonly<Record<string, string>> = {};

// ---------------------------------------------------------------------------
// What an indexer serves
// ---------------------------------------------------------------------------

/** `GET /manifest` — the working, plus the two things that qualify it. */
export interface Evidence {
  manifest: EvidenceManifestV1<CarriedEvidenceLeaf>;
  /** Riders whose store could not be read this pass. Not an error state: the
   *  count is then a FLOOR, and must never be shown as a finished total. */
  unreadable: string[];
  /** Riders who signed two different records at one point in their own
   *  history. Surfaced, never smoothed. */
  equivocations: string[];
  /** How stale the indexer's own answer was when it served it. */
  ageMs: number;
}

// ---------------------------------------------------------------------------
// Parsing — strict, because the page's honesty depends on knowing what it added
// ---------------------------------------------------------------------------

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

function parseLeaf(value: unknown): CarriedEvidenceLeaf | null {
  if (value === null || typeof value !== "object") return null;
  const l = value as Record<string, unknown>;
  if (typeof l.holder !== "string" || !HOLDER_RE.test(l.holder)) return null;
  if (typeof l.feedOwner !== "string" || !OWNER_RE.test(l.feedOwner)) return null;
  if (typeof l.digest !== "string" || !DIGEST_RE.test(l.digest)) return null;
  if (!isCount(l.seq) || !isCount(l.total) || !isCount(l.version)) return null;
  return {
    holder: l.holder,
    feedOwner: l.feedOwner as Hex0x,
    seq: l.seq,
    version: l.version,
    digest: l.digest as Hex0x,
    total: l.total,
  };
}

/**
 * Parse a served manifest, refusing anything it cannot fully account for.
 *
 * All-or-nothing on purpose. A leaf whose `total` arrived as a string would
 * make the recount CONCATENATE — "1" + "9" renders as a confident 19 — and a
 * page showing a number it did not understand is worse than one saying it could
 * not check, since being recomputed is the only reason to believe this number.
 *
 * `subject` is checked against the request too: a manifest for another subject
 * is a real answer to a different question, and rendering it under this
 * coaster's name would be the most convincing possible wrong number.
 */
export function parseEvidence(value: unknown, subject: Hex0x): Evidence | null {
  if (value === null || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (o.format !== "woco.evidence.v1") return null;
  if (o.statementFormat !== CREDIT_FORMAT) return null;
  if (typeof o.subject !== "string" || o.subject.toLowerCase() !== subject.toLowerCase()) return null;
  if (!isCount(o.count)) return null;

  const participants = stringList(o.participants, OWNER_RE);
  const unreadable = stringList(o.unreadable ?? [], OWNER_RE);
  const equivocations = stringList(o.equivocations ?? [], HOLDER_RE);
  if (participants === null || unreadable === null || equivocations === null) return null;
  if (!Array.isArray(o.leaves)) return null;

  const leaves: CarriedEvidenceLeaf[] = [];
  for (const raw of o.leaves) {
    const leaf = parseLeaf(raw);
    if (leaf === null) return null;
    leaves.push(leaf);
  }

  return {
    manifest: {
      format: "woco.evidence.v1",
      statementFormat: CREDIT_FORMAT,
      subject: o.subject.toLowerCase() as Hex0x,
      participants: participants as Hex0x[],
      leaves,
      count: o.count,
    },
    unreadable,
    equivocations,
    ageMs: isCount(o.ageMs) ? o.ageMs : 0,
  };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** The two numbers that must be the same number. */
export interface Reconciliation {
  /** What the manifest declares its leaves justify. */
  declared: number;
  /** What this browser got by adding the leaves up. */
  recounted: number;
  /** They agree. When they do not, the leaves win on screen and the page says
   *  so — the check doing its job, not an error. */
  holds: boolean;
}

export interface VerifyReport {
  subject: Hex0x;
  coaster: {
    name: string;
    park: string;
    /** Names it used to carry. A re-theme keeps the count and the memento. */
    formerNames: string[];
  };
  /**
   * Whose laps the headline is. `"rider"` when a challenge names one and their
   * record was found; `"community"` otherwise. The distinction is not cosmetic
   * — the two are different numbers over the same evidence.
   */
  scope: "rider" | "community";
  /** The headline: the featured rider's lifetime laps, or everyone's added up. */
  laps: number;
  /** The featured rider's leaf, when there is one and it was found. */
  featured: CarriedEvidenceLeaf | null;
  /** Everyone's laps on this coaster, added up here. */
  communityLaps: number;
  /** Riders with at least one lap on the record — i.e. holding the credit. */
  riders: number;
  read: {
    /** Riders the indexer declared it would look up. */
    declared: number;
    /** Of those, how many had a record it accepted. */
    contributing: number;
    /** Of those, how many could not be read. Above zero, the count is a FLOOR. */
    unreadable: number;
  };
  equivocations: string[];
  reconciliation: Reconciliation;
  /** The working, sorted as published. */
  leaves: CarriedEvidenceLeaf[];
  /** Where this came from, so a reader can re-run it without asking us. */
  sources: { indexer: string; manifestUrl: string };
  ageMs: number;
}

/**
 * Turn one indexer's evidence into what the page shows. Pure: no fetch, no
 * clock, no globals — which is what lets a different evidence source be swapped
 * in later without the page changing at all.
 */
export function buildReport(args: {
  subject: Hex0x;
  coaster: { name: string; park: string; formerNames: string[] };
  evidence: Evidence;
  sources: VerifyReport["sources"];
  /** Overrides the configured featured rider. A parameter so the challenge
   *  path is exercisable while the registry above is honestly empty. */
  featuredHolder?: string;
}): VerifyReport {
  const { manifest, unreadable, equivocations, ageMs } = args.evidence;
  const check = recountManifest(manifest);

  const featuredHolder = args.featuredHolder ?? FEATURED_HOLDERS[args.subject.toLowerCase()];
  const featured = featuredHolder
    ? (manifest.leaves.find((l) => l.holder === featuredHolder.toLowerCase()) ?? null)
    : null;

  return {
    subject: args.subject,
    coaster: args.coaster,
    scope: featured ? "rider" : "community",
    // The recount is the community headline, never the served `count`. The
    // strongest honest sentence available is that the number on screen is the
    // one this machine computed.
    laps: featured ? featured.total : check.recounted,
    featured,
    communityLaps: check.recounted,
    riders: manifest.leaves.filter((l) => l.total > 0).length,
    read: {
      declared: manifest.participants.length,
      contributing: manifest.leaves.length,
      unreadable: unreadable.length,
    },
    equivocations,
    reconciliation: { declared: manifest.count, recounted: check.recounted, holds: check.consistent },
    leaves: manifest.leaves,
    sources: args.sources,
    ageMs,
  };
}

// ---------------------------------------------------------------------------
// Which subjects this page will speak for
// ---------------------------------------------------------------------------

/**
 * Resolve a subject to a coaster this page is willing to name, or null.
 *
 * Gated on the shipped catalogue rather than on the hash being well-formed, and
 * that gate is load-bearing. Anyone can mint a subject id and publish genuinely
 * signed records against it; without this, a crafted link would render their
 * invented coaster in this page's typeface, with this page's authority, and
 * every number on it would be perfectly true. Refusing to name what we cannot
 * name is the whole difference.
 *
 * Costs nothing today (one entry) and follows the naming authority rather than
 * fixing it here: when issuers publish their own definitions, `SubjectCatalogue`
 * is replaced and this gate widens with it.
 */
export function resolveCoaster(
  subject: string,
  catalogue: SubjectCatalogue = WOCO_SUBJECTS,
): { subject: Hex0x; name: string; park: string; formerNames: string[] } | null {
  const normalised = subject.trim().toLowerCase();
  if (!SUBJECT_RE.test(normalised)) return null;
  const definition = lookupSubject(catalogue, normalised as Hex0x);
  if (!definition) return null;
  const era = currentEra(definition);
  return { subject: normalised as Hex0x, name: era.name, park: era.park, formerNames: formerNames(definition) };
}

// ---------------------------------------------------------------------------
// The HTTP source — one implementation of the seam, not the seam itself
// ---------------------------------------------------------------------------

/**
 * Where this page asks. Absolute in production builds, empty in dev (the Vite
 * proxy). Deliberately NOT overridable from the URL: "run your own indexer" is
 * a real escape hatch in this design, but a `?indexer=` parameter would let a
 * shared link render an official-looking count from a source of the sharer's
 * choosing — and this page exists to be shared. The proper form of that escape
 * hatch is a fork pointed at your own indexer, on your own domain, where the
 * authority is yours and the screenshot is unambiguous. The page prints the URL
 * it used so re-running the count needs no cooperation from us.
 */
export function indexerBase(): string {
  // Guarded rather than bare: the pure half of this module is exercised under
  // plain node, where `import.meta.env` does not exist at all.
  return import.meta.env?.VITE_API_URL || "";
}

export function manifestUrl(subject: Hex0x, base = indexerBase()): string {
  return `${base}/api/social/manifest?format=${encodeURIComponent(CREDIT_FORMAT)}&subject=${encodeURIComponent(subject)}`;
}

/** A displayable name for the indexer asked, for the "who added this up" line.
 *  Falls back to the page's own origin, which is what an empty base means. */
export function indexerName(base = indexerBase()): string {
  try {
    return new URL(base || globalThis.location?.href || "http://localhost").host;
  } catch {
    return base;
  }
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const resp = await fetch(url, { signal, headers: { Accept: "application/json" } });
  const text = await resp.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`the counter answered with something that is not JSON (HTTP ${resp.status})`);
  }
  const envelope = body as { ok?: boolean; data?: unknown; error?: string };
  if (!resp.ok || envelope?.ok !== true) {
    throw new Error(envelope?.error || `the counter answered HTTP ${resp.status}`);
  }
  return envelope.data;
}

export async function fetchVerifyReport(
  coaster: NonNullable<ReturnType<typeof resolveCoaster>>,
  opts: { base?: string; signal?: AbortSignal } = {},
): Promise<VerifyReport> {
  const base = opts.base ?? indexerBase();
  const sources = { indexer: indexerName(base), manifestUrl: manifestUrl(coaster.subject, base) };

  const evidence = parseEvidence(await getJson(sources.manifestUrl, opts.signal), coaster.subject);
  if (!evidence) throw new Error("the working did not arrive in a form this page can add up");

  return buildReport({
    subject: coaster.subject,
    coaster: { name: coaster.name, park: coaster.park, formerNames: coaster.formerNames },
    evidence,
    sources,
  });
}
