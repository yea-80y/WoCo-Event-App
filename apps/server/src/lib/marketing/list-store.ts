/**
 * Marketing list metadata store — per organiser: the Swarm ref of the current
 * SEALED contact blob + the HMAC hashes of its members (for dedupe and the
 * import validation report). No plaintext, ever. MUST survive restarts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./persist.js";

const DATA_DIR = join(process.cwd(), ".data");
const STORE_FILE = join(DATA_DIR, "marketing-lists.json");

export interface MarketingListEntry {
  swarmRef: string;
  count: number;
  updatedAt: string;
  emailHashes: string[];
}

const lists = new Map<string, MarketingListEntry>();
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(STORE_FILE, "utf-8");
    const obj = JSON.parse(raw) as Record<string, MarketingListEntry>;
    for (const [org, entry] of Object.entries(obj)) lists.set(org, entry);
  } catch {
    // File doesn't exist yet — that's fine
  }
}

function persistToDisk(): boolean {
  return writeJsonAtomic(STORE_FILE, Object.fromEntries(lists), "marketing-lists");
}

export function getList(organiserAddress: string): MarketingListEntry | null {
  ensureLoaded();
  return lists.get(organiserAddress.toLowerCase()) ?? null;
}

export function putList(organiserAddress: string, entry: MarketingListEntry): void {
  ensureLoaded();
  lists.set(organiserAddress.toLowerCase(), entry);
  persistToDisk();
}

/** Every organiser whose stored list contains this hash. Subject-access support. */
export function listsContaining(emailHash: string): string[] {
  ensureLoaded();
  const out: string[] = [];
  for (const [org, entry] of lists) {
    if (entry.emailHashes.includes(emailHash)) out.push(org);
  }
  return out;
}

/**
 * Erasure support — drops one member from an organiser's stored list index.
 *
 * This is what makes the member unsendable: `/api/marketing/broadcast` refuses
 * any recipient not in this index. It does NOT rewrite the organiser's sealed
 * contact blob on Swarm — that is encrypted to them and only they can re-upload
 * it, which is exactly why an erasure must also leave a suppression mark behind.
 * Without one, the organiser's next CSV re-upload silently restores the member.
 *
 * @returns the organisers whose list was actually modified.
 */
export function removeFromLists(emailHash: string, organiserAddress?: string): string[] {
  ensureLoaded();
  const scope = organiserAddress?.toLowerCase();
  const touched: string[] = [];
  for (const [org, entry] of lists) {
    if (scope && org !== scope) continue;
    const next = entry.emailHashes.filter((h) => h !== emailHash);
    if (next.length === entry.emailHashes.length) continue;
    lists.set(org, { ...entry, emailHashes: next, count: next.length });
    touched.push(org);
  }
  if (touched.length) persistToDisk();
  return touched;
}

/** Per-organiser mutex: serialises import/delete races on one list. */
const orgLocks = new Map<string, Promise<void>>();
export function withOrgLock<T>(organiserAddress: string, fn: () => Promise<T> | T): Promise<T> {
  const org = organiserAddress.toLowerCase();
  const prev = orgLocks.get(org) ?? Promise.resolve();
  const next = prev.then(() => fn());
  orgLocks.set(org, next.then(() => {}, () => {}));
  return next as Promise<T>;
}
