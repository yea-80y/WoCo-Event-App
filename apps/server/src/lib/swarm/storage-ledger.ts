/**
 * Per-owner storage ledger — every stamped upload recorded as {ref, bytes, batch}.
 *
 * Two jobs, one file:
 *  1. QUOTA — free-hosted deploys (shared platform Etherna batch) are capped per
 *     owner. The stamps endpoint can't do this: utilization is a per-bucket
 *     high-water mark, not bytes, and on a shared batch it attributes nothing.
 *  2. MIGRATION MANIFEST — re-stamping content on another batch preserves its
 *     Swarm address (verified 2026-07-14), so this ref list is exactly what a
 *     future move to a user-owned batch/bee walks. You can only re-stamp what
 *     you can still read AND enumerate; this is the enumeration.
 *
 * File-backed JSON (same pattern as stripe-accounts.ts / tx-registry.ts) —
 * `.data/storage-ledger.json` MUST survive restarts.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), ".data");
const LEDGER_FILE = join(DATA_DIR, "storage-ledger.json");

export interface StoredUpload {
  /** Swarm root reference (hex, no 0x). Stewardship re-stamp walks from here. */
  ref: string;
  bytes: number;
  /** What the bytes are, e.g. "site-deploy" — for capacity reporting by kind. */
  kind: string;
  batchId: string;
  target: "wocoBee" | "etherna";
  at: string;
  /** Optional context (siteId, eventId, …). */
  note?: string;
  /** True when this upload was subsidised by the free-hosting promo (website on
   *  the shared platform batch). ONLY these bytes count against the free quota —
   *  event pages are always free and user-batch deploys are already paid for. */
  freeHosted?: boolean;
}

interface OwnerLedger {
  usedBytes: number;
  uploads: StoredUpload[];
}

let store: Record<string, OwnerLedger> = {};
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    store = JSON.parse(readFileSync(LEDGER_FILE, "utf-8"));
    console.log(`[storage-ledger] Loaded ${Object.keys(store).length} owners from disk`);
  } catch {
    // First run — file doesn't exist yet.
  }
}

function persist(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(LEDGER_FILE, JSON.stringify(store, null, 2), "utf-8");
  } catch (err) {
    console.error("[storage-ledger] Failed to persist:", err);
  }
}

export function recordUpload(ownerAddress: string, upload: Omit<StoredUpload, "at">): void {
  ensureLoaded();
  const key = ownerAddress.toLowerCase();
  const owner = (store[key] ??= { usedBytes: 0, uploads: [] });
  owner.uploads.push({ ...upload, at: new Date().toISOString() });
  owner.usedBytes += upload.bytes;
  persist();
  console.log(
    `[storage-ledger] ${key.slice(0, 10)}… +${upload.bytes}B (${upload.kind}) → ${owner.usedBytes}B total`,
  );
}

export function getUsedBytes(ownerAddress: string): number {
  ensureLoaded();
  return store[ownerAddress.toLowerCase()]?.usedBytes ?? 0;
}

/**
 * Bytes consumed under the free-hosting promo only — the quota denominator.
 *
 * Site deploys count LATEST-PER-SITE, not cumulative: a republish supersedes the
 * previous deploy of the same siteId (`note`), so iterating on a site never burns
 * quota. Superseded refs stay in `uploads` (they are still the migration/GC
 * manifest — a future re-stamp onto a fresh batch walks only the live set, which
 * is what actually garbage-collects dead versions). Non-deploy free-hosted kinds
 * (e.g. site images) accumulate — there is no supersede signal for them.
 *
 * `excludeSite` drops that site's current deploy from the total — used when
 * quota-checking a REdeploy, whose new tar replaces the existing one.
 */
export function getFreeHostedBytes(ownerAddress: string, opts: { excludeSite?: string } = {}): number {
  ensureLoaded();
  const uploads = store[ownerAddress.toLowerCase()]?.uploads ?? [];
  let sum = 0;
  const latestSiteDeploy = new Map<string, number>();
  for (const u of uploads) {
    if (!u.freeHosted) continue;
    // Uploads are appended chronologically, so the last entry per siteId wins.
    if (u.kind === "site-deploy" && u.note) latestSiteDeploy.set(u.note, u.bytes);
    else sum += u.bytes;
  }
  for (const [siteId, bytes] of latestSiteDeploy) {
    if (siteId !== opts.excludeSite) sum += bytes;
  }
  return sum;
}

/** The owner's full upload history — the migration manifest. */
export function getUploads(ownerAddress: string): StoredUpload[] {
  ensureLoaded();
  return store[ownerAddress.toLowerCase()]?.uploads ?? [];
}
