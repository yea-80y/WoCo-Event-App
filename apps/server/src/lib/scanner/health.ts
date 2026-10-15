/**
 * `/api/health` `scanner`: does the build `scan.<parent>` is answered with
 * still serve the files a door phone cannot work without?
 *
 * The scanner broke once exactly this way: it had been uploaded under a postage
 * batch that later died, nothing re-uploaded it, and its `sw.js`, workbox and QR
 * worker stopped existing while every page that named them still did. Phones
 * holding the old service worker could never update. Nothing said so.
 *
 * Every ~10 min the feed is re-read (latest-build.ts) and the build's critical
 * files are fetched in full from our own bee: `index.html`, `sw.js`, the workbox
 * runtime `sw.js` loads, and EVERY script, stylesheet and page `sw.js`
 * precaches. Workbox installs all or nothing, so one lost lazy chunk strands
 * every phone on its old worker exactly as a lost entry script would. A missing
 * manifest path is answered by bee with the error document (`index.html`) and a
 * 200, so a file only counts as served when its content type is the one its
 * extension needs - which a browser enforces on `sw.js` anyway.
 *
 * Red when the feed cannot be read or any critical file is not served.
 *
 * WHAT THIS CANNOT SEE. It reads OUR bee, which can keep serving a chunk from
 * its own store after a dead batch has let the network drop it - so green here
 * is not proof that a phone elsewhere can load the build. The real guards are
 * upstream: every frontend deploy re-uploads the scanner under the current batch
 * (`npm run deploy`), and the `postage` section alarms before a batch dies.
 */
import { BEE_URL } from "../../config/swarm.js";
import { errorClass } from "../http/error-class.js";
import { SWARM_READ_MAX_BYTES, readCapped } from "../http/read-capped.js";
import type { Check, Verdict } from "../health/alarms.js";
import { isStale } from "../health/alarms.js";
import { scannerBuild, type ScannerBuildState } from "./latest-build.js";

export const SCANNER_PROBE_INTERVAL_MS = 10 * 60_000;
const FILE_TIMEOUT_MS = 30_000;

export type BuildFileRead =
  | { ok: true; body: Uint8Array; contentType: string }
  | { ok: false; reason: string };

export type FetchBuildFile = (ref: string, path: string) => Promise<BuildFileRead>;

export interface ScannerReading {
  at: number;
  build: string | null;
  feedIndex: bigint | null;
  feedError: string | null;
  /** The critical files checked, in order. */
  files: string[];
  missing: Array<{ path: string; reason: string }>;
  /** `index.html` or `sw.js` did not name a file the scanner needs. */
  namingError: string | null;
}

/** A precache url this probe will fetch: relative, no `..`, no scheme or query. */
const PLAIN_PATH = /^(?!.*\.\.)\w[\w./-]*$/;
const CHECKED = /\.(js|css|html)$/;

/**
 * The files a door phone cannot run without, beyond `index.html` and `sw.js`:
 * the workbox runtime `sw.js` loads and every script, stylesheet and page it
 * precaches - or why they cannot be named. Pure.
 */
export function criticalScannerFiles(indexHtml: string, swJs: string): { files: string[] } | { error: string } {
  const entry = /<script\b[^>]*\bsrc="\.?\/?(assets\/scanner-[\w-]+\.js)"/.exec(indexHtml)?.[1];
  if (!entry) return { error: "index.html names no assets/scanner-*.js entry" };
  const workbox = /define\(\["\.\/(workbox-[\w-]+)"\]/.exec(swJs)?.[1];
  if (!workbox) return { error: "sw.js names no workbox runtime" };
  const precached = [...swJs.matchAll(/url:"([^"]*)"/g)].map((m) => m[1]!);
  if (precached.some((u) => !PLAIN_PATH.test(u))) return { error: "sw.js precaches a url that is not a plain relative path" };
  if (!precached.includes(entry)) return { error: `sw.js does not precache the entry script ${entry}` };
  if (!precached.some((u) => /^assets\/qr-scanner-worker\.min-[\w-]+\.js$/.test(u))) {
    return { error: "sw.js precaches no assets/qr-scanner-worker.min-*.js" };
  }
  const files = new Set([`${workbox}.js`]);
  for (const u of precached) if (CHECKED.test(u) && u !== "index.html" && u !== "sw.js") files.add(u);
  return { files: [...files] };
}

/** The content type a path must be served with, or null when any will do. */
function expectedType(path: string): RegExp | null {
  if (path.endsWith(".js")) return /javascript/i;
  if (path.endsWith(".css")) return /text\/css/i;
  if (path.endsWith(".html")) return /html/i;
  return null;
}

/** Why `read` is not `path` served, or null when it is. Pure. */
export function notServedReason(path: string, read: BuildFileRead): string | null {
  if (!read.ok) return read.reason;
  const want = expectedType(path);
  if (want && !want.test(read.contentType)) return `served as ${read.contentType || "no content type"}`;
  return null;
}

/** The section's verdict over a reading. Pure. */
export function evaluateScanner(r: ScannerReading | null): Check {
  if (!r) return { ok: null, reason: "not checked yet" };
  if (!r.build) return { ok: false, reason: `scan cannot be answered: ${r.feedError ?? "no build known"}` };
  if (r.feedError) return { ok: false, reason: `the scanner feed cannot be read (answering the last good build): ${r.feedError}` };
  if (r.namingError) return { ok: false, reason: r.namingError };
  if (r.missing.length > 0) return { ok: false, reason: `not served from our bee: ${r.missing.map((m) => m.path).join(", ")}` };
  return { ok: true };
}

/** Re-read the feed, then fetch the build's critical files. Never throws. */
export async function probeScanner(
  source: { refresh(): Promise<ScannerBuildState> },
  fetchFile: FetchBuildFile,
  now: () => number = Date.now,
): Promise<ScannerReading> {
  const state = await source.refresh();
  const reading: ScannerReading = {
    at: now(),
    build: state.build?.ref ?? null,
    feedIndex: state.build?.index ?? null,
    feedError: state.error,
    files: [],
    missing: [],
    namingError: null,
  };
  const ref = reading.build;
  if (!ref) return reading;

  const check = async (path: string): Promise<BuildFileRead> => {
    reading.files.push(path);
    const read = await fetchFile(ref, path).catch((err): BuildFileRead => ({ ok: false, reason: errorClass(err) }));
    const why = notServedReason(path, read);
    if (why) reading.missing.push({ path, reason: why });
    return read;
  };
  const index = await check("index.html");
  const sw = await check("sw.js");
  if (!index.ok || !sw.ok || reading.missing.length > 0) return reading;

  const decode = (b: Uint8Array) => new TextDecoder().decode(b);
  const named = criticalScannerFiles(decode(index.body), decode(sw.body));
  if ("error" in named) {
    reading.namingError = named.error;
    return reading;
  }
  for (const path of named.files) await check(path);
  return reading;
}

/** A full GET from our bee, so every chunk of the file is retrieved, not just its root. */
export const fetchFromOurBee: FetchBuildFile = async (ref, path) => {
  try {
    const r = await fetch(`${BEE_URL}/bzz/${ref}/${path}`, { signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
    if (r.status !== 200) {
      await r.body?.cancel().catch(() => {});
      return { ok: false, reason: `HTTP ${r.status}` };
    }
    const body = await readCapped(r, SWARM_READ_MAX_BYTES, `scanner ${path}`);
    return { ok: true, body, contentType: r.headers.get("content-type") ?? "" };
  } catch (err) {
    return { ok: false, reason: errorClass(err) };
  }
};

let reading: ScannerReading | null = null;
let lastVerdict: Verdict | undefined;
let timer: NodeJS.Timeout | null = null;

export interface ScannerSection {
  ok: Verdict;
  reason?: string;
  stale: boolean;
  checkedAt: string | null;
  /** The collection `scan.<parent>` is answered with. Public: the name publishes it. */
  build: string | null;
  feedIndex: number | null;
  files: string[];
  missing: Array<{ path: string; reason: string }>;
  feedError?: string;
}

export function scannerHealth(now: number = Date.now()): ScannerSection {
  const verdict = evaluateScanner(reading);
  return {
    ok: verdict.ok,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
    stale: isStale(reading?.at ?? null, now, SCANNER_PROBE_INTERVAL_MS),
    checkedAt: reading ? new Date(reading.at).toISOString() : null,
    build: reading?.build ?? null,
    feedIndex: reading?.feedIndex === null || reading?.feedIndex === undefined ? null : Number(reading.feedIndex),
    files: reading?.files ?? [],
    missing: reading?.missing ?? [],
    ...(reading?.feedError ? { feedError: reading.feedError } : {}),
  };
}

export async function refreshScannerHealth(
  source: { refresh(): Promise<ScannerBuildState> } = scannerBuild,
  fetchFile: FetchBuildFile = fetchFromOurBee,
  log: (line: string) => void = console.warn,
): Promise<void> {
  reading = await probeScanner(source, fetchFile);
  const verdict = evaluateScanner(reading);
  // One line per crossing, like the other probes: a line every tick is read by nobody.
  if (verdict.ok !== lastVerdict) {
    lastVerdict = verdict.ok;
    log(`[health] scanner: ${verdict.ok === true ? "ok" : verdict.ok === false ? "ALARM" : "unknown"}${verdict.reason ? ` - ${verdict.reason}` : ""}`);
  }
}

/** Also warms the build before eth.limo first asks for `scan`. */
export function startScannerProbe(): void {
  if (timer) return;
  const tick = () => void refreshScannerHealth().catch((err) => console.warn("[health] scanner probe threw:", err));
  tick();
  timer = setInterval(tick, SCANNER_PROBE_INTERVAL_MS);
  timer.unref?.();
}

/** Tests only. */
export function __resetScannerHealth(): void {
  if (timer) clearInterval(timer);
  timer = null;
  reading = null;
  lastVerdict = undefined;
}
