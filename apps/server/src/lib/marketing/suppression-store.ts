/**
 * Marketing suppression list — the enforcement layer for unsubscribes.
 *
 * Keyed by HMAC email hash (hashEmail), never plaintext. Checked on EVERY
 * marketing/broadcast send, so an unsubscribe survives the organiser
 * re-uploading the same CSV. Per-organiser scope by default (the organiser is
 * the data controller under GDPR); global scope for "block all marketing via
 * WoCo", bounces and spam complaints.
 *
 * MUST survive server restarts — same rule as consumed-tx-hashes.json.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), ".data");
const STORE_FILE = join(DATA_DIR, "marketing-suppression.json");

export type SuppressSource = "unsub" | "unsub_all" | "bounce" | "complaint" | "manual";

interface SuppressionMark {
  ts: string;
  source: SuppressSource;
}

interface SuppressionEntry {
  global?: SuppressionMark;
  orgs: Record<string, SuppressionMark>;
}

const entries = new Map<string, SuppressionEntry>();
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(STORE_FILE, "utf-8");
    const obj = JSON.parse(raw) as Record<string, SuppressionEntry>;
    for (const [hash, entry] of Object.entries(obj)) entries.set(hash, entry);
    console.log(`[suppression] Loaded ${entries.size} suppressed addresses from disk`);
  } catch {
    // File doesn't exist yet — that's fine
  }
}

function persistToDisk(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STORE_FILE, JSON.stringify(Object.fromEntries(entries)), "utf-8");
  } catch (err) {
    console.error("[suppression] Failed to persist to disk:", err);
  }
}

function getOrCreate(emailHash: string): SuppressionEntry {
  let entry = entries.get(emailHash);
  if (!entry) {
    entry = { orgs: {} };
    entries.set(emailHash, entry);
  }
  return entry;
}

/** Suppress this address for one organiser's marketing (unsubscribe default scope). */
export function suppressOrg(emailHash: string, organiserAddress: string, source: SuppressSource): void {
  ensureLoaded();
  const entry = getOrCreate(emailHash);
  const org = organiserAddress.toLowerCase();
  // First mark wins — an earlier unsub isn't downgraded by a later re-mark
  if (!entry.orgs[org]) {
    entry.orgs[org] = { ts: new Date().toISOString(), source };
    persistToDisk();
  }
}

/** Suppress this address for ALL marketing via the platform (opt-all, bounce, complaint). */
export function suppressGlobal(emailHash: string, source: SuppressSource): void {
  ensureLoaded();
  const entry = getOrCreate(emailHash);
  if (!entry.global) {
    entry.global = { ts: new Date().toISOString(), source };
    persistToDisk();
  }
}

/** Is this address suppressed for this organiser (globally or per-org)? */
export function isSuppressed(emailHash: string, organiserAddress: string): boolean {
  ensureLoaded();
  const entry = entries.get(emailHash);
  if (!entry) return false;
  return Boolean(entry.global || entry.orgs[organiserAddress.toLowerCase()]);
}

/** Subset of the given hashes that are suppressed for this organiser. */
export function suppressedSubset(organiserAddress: string, emailHashes: string[]): string[] {
  ensureLoaded();
  const org = organiserAddress.toLowerCase();
  return emailHashes.filter((h) => {
    const entry = entries.get(h);
    return Boolean(entry && (entry.global || entry.orgs[org]));
  });
}
