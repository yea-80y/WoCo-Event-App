/**
 * The site runtime release (#1032): one immutable upload per release of BOTH
 * organiser runtimes - websites (`apps/web/dist-multisite`, line `site`) and
 * single-event pages (`apps/web/dist-site`, line `eventPage`) - which pages link
 * into their own Swarm manifests instead of carrying a copy. One descriptor, one
 * commit, both lines REQUIRED (v2): two release lines could drift, and a page
 * left on old code is exactly the #642 miss (STEP 1c forgotten).
 *
 * A release is described by a small JSON document, signed as the latest update
 * of the `SITE_RUNTIME_FEED_TOPIC` feed under the frontend deploy key
 * (`SITE_RUNTIME_RELEASE_OWNER`). The feed is for DISCOVERY only: a site pins the
 * root it linked, and the signature on the feed update is what makes the
 * descriptor ours. Never derive anything a site depends on from "latest" alone.
 *
 * The same build gets a different root on our bee and on Etherna (each node
 * encodes the manifest its own way; measured 2026-11-02), so a release carries
 * one entry per store. `edges` are the root's top-level fork prefixes (e.g.
 * "assets/") and the address of the node each leads to: a site links those
 * nodes, loading each one first so its fork type bits are right.
 */

export const SITE_RUNTIME_FORMAT = "woco.site-runtime.v2" as const;
/** The feed keeps its name across formats: a v1 descriptor on it is simply refused. */
export const SITE_RUNTIME_FEED_TOPIC = "woco-site-runtime-v1";
/** The frontend deploy key's address (scripts/.env FEED_PRIVATE_KEY): it signs the app feed too. */
export const SITE_RUNTIME_RELEASE_OWNER = "0xf8af4904c6e4f08ce5f7deab7f01221280b23a80";

export type SiteRuntimeStore = "woco" | "etherna";

/** The two runtimes a release carries. */
export type SiteRuntimeLine = "site" | "eventPage";
export const SITE_RUNTIME_LINES: readonly SiteRuntimeLine[] = ["site", "eventPage"];
/** Each line's index document, which a page writes itself and never takes from the release. */
export const SITE_RUNTIME_INDEX_DOCUMENT: Record<SiteRuntimeLine, string> = {
  site: "multi-site.html",
  eventPage: "site.html",
};

export interface SiteRuntimeRoot {
  /** Root of the uploaded collection, 64 hex, no 0x. */
  root: string;
  /**
   * Shared DIRECTORY edges a site links whole: top-level prefix ("assets/") ->
   * address of the node it leads to. Never an edge holding a per-site file
   * (the release's own multi-site.html / manifest.json): a site writes those.
   */
  edges: Record<string, string>;
  /** Shared top-level FILES a site adds one by one: path -> data reference + content type. */
  files: Record<string, { ref: string; contentType: string }>;
  /** The collection's index document. */
  indexDocument: string;
}

/** One runtime of a release: what was built and where each store holds it. */
export interface SiteRuntimeLineRelease {
  dist: { files: number; bytes: number };
  roots: { woco: SiteRuntimeRoot } & Partial<Record<Exclude<SiteRuntimeStore, "woco">, SiteRuntimeRoot>>;
}

export interface SiteRuntimeRelease {
  format: typeof SITE_RUNTIME_FORMAT;
  /** Strictly increasing per publish. */
  version: number;
  /** Full git commit both runtimes were built from. */
  commit: string;
  /** ISO time of the build. */
  builtAt: string;
  runtimes: Record<SiteRuntimeLine, SiteRuntimeLineRelease>;
}

const HEX64 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
/** A top-level directory edge: printable, ends in "/", no leading slash, at most 30 bytes (one mantaray prefix). */
const EDGE = /^[\x21-\x2e\x30-\x7e][\x21-\x7e]{0,28}\/$/;
/** A top-level shared file: a plain name, no directories. */
const FILE = /^[\w-][\w.-]{0,63}$/;
/**
 * The only types a shared file may carry: what a page loads as a subresource and
 * never opens as a document. No HTML, no SVG, no XML - each can run script when
 * opened directly, and a site root serves these on our gateway's origin.
 */
const SHARED_FILE_TYPE =
  /^(image\/(png|jpeg|webp|gif|avif|x-icon|vnd\.microsoft\.icon)|font\/[\w.+-]+|text\/css|(application|text)\/javascript|application\/(json|manifest\+json))(; ?charset=[\w-]+)?$/i;
const MAX_EDGES = 32;

export function isSiteRuntimeFileType(contentType: string): boolean {
  return SHARED_FILE_TYPE.test(contentType);
}

function parseRoot(v: unknown, indexDocument: string): SiteRuntimeRoot | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.root !== "string" || !HEX64.test(r.root)) return null;
  if (r.indexDocument !== indexDocument) return null;
  if (!r.edges || typeof r.edges !== "object" || Array.isArray(r.edges)) return null;
  const entries = Object.entries(r.edges as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_EDGES) return null;
  const edges: Record<string, string> = {};
  for (const [prefix, addr] of entries) {
    if (!EDGE.test(prefix) || typeof addr !== "string" || !HEX64.test(addr)) return null;
    edges[prefix] = addr;
  }
  if (!r.files || typeof r.files !== "object" || Array.isArray(r.files)) return null;
  const fileEntries = Object.entries(r.files as Record<string, unknown>);
  if (fileEntries.length > MAX_EDGES) return null;
  const files: Record<string, { ref: string; contentType: string }> = {};
  for (const [name, f] of fileEntries) {
    const file = f as { ref?: unknown; contentType?: unknown } | null;
    if (!FILE.test(name) || name === r.indexDocument || name === "manifest.json") return null;
    if (!file || typeof file.ref !== "string" || !HEX64.test(file.ref)) return null;
    if (typeof file.contentType !== "string" || !isSiteRuntimeFileType(file.contentType)) return null;
    files[name] = { ref: file.ref, contentType: file.contentType };
  }
  return { root: r.root, edges, files, indexDocument };
}

function parseLine(v: unknown, line: SiteRuntimeLine): SiteRuntimeLineRelease | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const l = v as Record<string, unknown>;
  for (const k of Object.keys(l)) if (k !== "dist" && k !== "roots") return null;
  const dist = l.dist as Record<string, unknown> | undefined;
  if (!dist || !Number.isSafeInteger(dist.files) || !Number.isSafeInteger(dist.bytes)) return null;
  if ((dist.files as number) < 1 || (dist.bytes as number) < 1) return null;
  const roots = l.roots as Record<string, unknown> | undefined;
  if (!roots || typeof roots !== "object" || Array.isArray(roots)) return null;
  for (const k of Object.keys(roots)) if (k !== "woco" && k !== "etherna") return null;
  const index = SITE_RUNTIME_INDEX_DOCUMENT[line];
  const woco = parseRoot(roots.woco, index);
  if (!woco) return null;
  const out: SiteRuntimeLineRelease = { dist: { files: dist.files as number, bytes: dist.bytes as number }, roots: { woco } };
  if (roots.etherna !== undefined) {
    const etherna = parseRoot(roots.etherna, index);
    if (!etherna) return null;
    out.roots.etherna = etherna;
  }
  return out;
}

/**
 * The descriptor, or null when anything is off. Strict on purpose: it names
 * addresses a site will link and the server will admit, so a malformed field
 * is a refusal, never a best guess.
 */
export function parseSiteRuntimeRelease(v: unknown): SiteRuntimeRelease | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const d = v as Record<string, unknown>;
  if (d.format !== SITE_RUNTIME_FORMAT) return null;
  if (typeof d.version !== "number" || !Number.isSafeInteger(d.version) || d.version < 1) return null;
  if (typeof d.commit !== "string" || !COMMIT.test(d.commit)) return null;
  if (typeof d.builtAt !== "string" || Number.isNaN(Date.parse(d.builtAt))) return null;
  const runtimes = d.runtimes as Record<string, unknown> | undefined;
  if (!runtimes || typeof runtimes !== "object" || Array.isArray(runtimes)) return null;
  for (const k of Object.keys(runtimes)) if (!(SITE_RUNTIME_LINES as readonly string[]).includes(k)) return null;
  const site = parseLine(runtimes.site, "site");
  const eventPage = parseLine(runtimes.eventPage, "eventPage");
  if (!site || !eventPage) return null;
  return { format: SITE_RUNTIME_FORMAT, version: d.version, commit: d.commit, builtAt: d.builtAt, runtimes: { site, eventPage } };
}
