/**
 * Transaction hash registry — prevents payment replay attacks.
 *
 * Tracks which txHashes have already been consumed for ticket claims.
 * In-memory Set backed by a JSON file so state survives restarts.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const DATA_DIR = join(process.cwd(), ".data");
const REGISTRY_FILE = join(DATA_DIR, "consumed-tx-hashes.json");

/** In-memory set of consumed tx hashes (lowercase, with 0x prefix) */
const consumed = new Set<string>();

/** Whether we've loaded from disk yet */
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(REGISTRY_FILE, "utf-8");
    const arr = JSON.parse(raw) as string[];
    for (const h of arr) consumed.add(h.toLowerCase());
    console.log(`[tx-registry] Loaded ${consumed.size} consumed tx hashes from disk`);
  } catch {
    // File doesn't exist yet — that's fine
  }
}

function persistToDisk(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(REGISTRY_FILE, JSON.stringify([...consumed]), "utf-8");
  } catch (err) {
    console.error("[tx-registry] Failed to persist to disk:", err);
  }
}

/**
 * Check if a txHash has already been consumed.
 * Returns true if the hash is new (not yet consumed).
 * Returns false if it's a replay (already used).
 */
export function checkAndConsumeTxHash(txHash: string): boolean {
  ensureLoaded();
  const normalized = txHash.toLowerCase();
  if (consumed.has(normalized)) {
    return false; // replay — already consumed
  }
  consumed.add(normalized);
  persistToDisk();
  return true; // new — now consumed
}

/**
 * Check if a txHash has been consumed without consuming it.
 */
export function isTxHashConsumed(txHash: string): boolean {
  ensureLoaded();
  return consumed.has(txHash.toLowerCase());
}
