/**
 * What each WoCo-built feed last published, as the server itself baked it.
 *
 * A site or event-page name points at a FEED MANIFEST its holder signed once at
 * bind; the feed behind it answers to the holder's own key, so the holder could
 * push any collection to it. The passkey RP ID is `woco.eth.limo` and, in a
 * browser whose Public Suffix List predates 2026-09-01, any page under it can ask
 * for the user's passkey, so nothing a holder authored may ever be served at a
 * name. The CCIP gateway therefore never signs the holder's pointer: it signs the
 * immutable collection this ledger says the server last deployed for that feed
 * (ens-gateway/ccip.ts `contenthashPolicy`), and the app for anything else.
 *
 * Keyed by the feed manifest hash - the very bytes the holder already signed - so
 * no name needs re-binding; one republish adds a feed. Written synchronously by
 * both deploy routes (routes/sites.ts, routes/site.ts) after the collection is up.
 *
 * MUST SURVIVE RESTARTS. Losing it fails SAFE: every site and event-page name shows
 * the app until it is republished. A file that exists and cannot be read is never
 * overwritten, is served as EMPTY (every name -> the app) and `/api/health`
 * `nameTargets` alarms until an operator restores it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../marketing/persist.js";

const FILE = join(process.cwd(), ".data", "name-targets.json");
const HEX64 = /^[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;

export interface NameTarget {
  kind: "site" | "event";
  /** siteId or eventId. */
  id: string;
  /** The verified session parent that deployed it, lowercase. */
  owner: string;
  /** The immutable collection the server baked on its latest deploy, 64-hex. */
  latestRef: string;
  at: string;
}

let targets = new Map<string, NameTarget>();
/** Entries that did not parse: kept on disk untouched, never served. */
let unparsed = new Map<string, unknown>();
let fileUnreadable: string | null = null;
let writeFailures = 0;
let loaded = false;

function parseTarget(v: unknown): NameTarget | null {
  const t = v as Partial<NameTarget> | null;
  if (!t || typeof t !== "object") return null;
  if (t.kind !== "site" && t.kind !== "event") return null;
  if (typeof t.id !== "string" || !t.id) return null;
  if (typeof t.owner !== "string" || !ADDRESS.test(t.owner)) return null;
  if (typeof t.latestRef !== "string" || !HEX64.test(t.latestRef)) return null;
  if (typeof t.at !== "string") return null;
  return { kind: t.kind, id: t.id, owner: t.owner, latestRef: t.latestRef, at: t.at };
}

function refuseFile(why: string): void {
  fileUnreadable = why;
  console.error(
    `[name-targets] ALARM: name-targets.json ${why} - every site and event-page name now shows the app, ` +
      "and the file will NOT be written until it is repaired or restored and the server restarted " +
      "(/api/health nameTargets)",
  );
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  let raw: string;
  try {
    raw = readFileSync(FILE, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return; // first boot
    return refuseFile(`exists but could not be read (${code ?? "unknown error"})`);
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return refuseFile("is not valid JSON");
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return refuseFile("is not a JSON object");
  for (const [manifest, v] of Object.entries(obj as Record<string, unknown>)) {
    const t = HEX64.test(manifest) ? parseTarget(v) : null;
    if (t) targets.set(manifest, t);
    else unparsed.set(manifest, v);
  }
  if (unparsed.size > 0) {
    console.error(
      `[name-targets] ${unparsed.size} record(s) in name-targets.json are unreadable - kept on disk ` +
        "untouched, NOT served: those names show the app until republished",
    );
  }
}

/**
 * Record what a deploy just published behind `feedManifestHash`. Returns false
 * when nothing was written (store unreadable, bad input, disk failure): the name
 * then keeps showing what it showed before, or the app - never the holder's feed.
 */
export function recordNameTarget(
  feedManifestHash: string,
  t: { kind: "site" | "event"; id: string; owner: string; latestRef: string },
): boolean {
  ensureLoaded();
  if (fileUnreadable) return false;
  const manifest = feedManifestHash.replace(/^0x/, "").toLowerCase();
  const latestRef = t.latestRef.replace(/^0x/, "").toLowerCase();
  const owner = t.owner.toLowerCase();
  if (!HEX64.test(manifest) || !HEX64.test(latestRef) || !ADDRESS.test(owner) || !t.id) {
    console.error(`[name-targets] refused a malformed record for ${t.kind} ${t.id}`);
    return false;
  }
  const prev = targets.get(manifest);
  const next: NameTarget = { kind: t.kind, id: t.id, owner, latestRef, at: new Date().toISOString() };
  targets.set(manifest, next);
  // A fresh deploy repairs an unreadable record for the same manifest; kept, it
  // would be written over the new one and the name could never be fixed.
  const garbage = unparsed.get(manifest);
  const hadGarbage = unparsed.delete(manifest);
  const out: Record<string, unknown> = Object.fromEntries(targets);
  for (const [k, v] of unparsed) out[k] = v;
  if (!writeJsonAtomic(FILE, out, "name-targets")) {
    // Not durable means not served: a restart would forget it, and serving it now
    // would make the name's content depend on whether we restart.
    if (prev) targets.set(manifest, prev);
    else targets.delete(manifest);
    if (hadGarbage) unparsed.set(manifest, garbage);
    writeFailures++;
    return false;
  }
  return true;
}

/** The latest WoCo-built collection behind a feed manifest, or null. Zero I/O after load. */
export function lookupNameTarget(feedManifestHash: string): string | null {
  ensureLoaded();
  if (fileUnreadable) return null;
  return targets.get(feedManifestHash.replace(/^0x/, "").toLowerCase())?.latestRef ?? null;
}

/** `/api/health` section. Counts only: this endpoint is public. */
export function nameTargetsHealth(): {
  ok: boolean;
  unreadable: boolean;
  unreadableRecords: number;
  writeFailures: number;
  count: number;
} {
  ensureLoaded();
  const unreadable = fileUnreadable !== null;
  return {
    ok: !unreadable && unparsed.size === 0 && writeFailures === 0,
    unreadable,
    unreadableRecords: unparsed.size,
    writeFailures,
    count: targets.size,
  };
}

/** Tests only: forget memory so the next call reloads from disk. */
export function __resetNameTargetsForTest(): void {
  targets = new Map();
  unparsed = new Map();
  fileUnreadable = null;
  writeFailures = 0;
  loaded = false;
}
