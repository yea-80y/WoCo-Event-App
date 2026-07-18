/**
 * Marketing list metadata store — per organiser: the Swarm ref of the current
 * SEALED contact blob + the HMAC hashes of its members (for dedupe and the
 * import validation report). No plaintext, ever. MUST survive restarts.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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

function persistToDisk(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STORE_FILE, JSON.stringify(Object.fromEntries(lists)), "utf-8");
  } catch (err) {
    console.error("[marketing-lists] Failed to persist to disk:", err);
  }
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

/** Per-organiser mutex: serialises import/delete races on one list. */
const orgLocks = new Map<string, Promise<void>>();
export function withOrgLock<T>(organiserAddress: string, fn: () => Promise<T> | T): Promise<T> {
  const org = organiserAddress.toLowerCase();
  const prev = orgLocks.get(org) ?? Promise.resolve();
  const next = prev.then(() => fn());
  orgLocks.set(org, next.then(() => {}, () => {}));
  return next as Promise<T>;
}
