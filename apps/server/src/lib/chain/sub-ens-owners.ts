/**
 * Sub-ENS owner index — tracks which labels each address has claimed through WoCo.
 *
 * Both claim paths flow through the server (sponsor mint via /claim, EIP-712 permit
 * sign via /permit), so this file is the source of truth for "names this user owns".
 * It is intentionally optimistic — the /permit path records before the client's userOp
 * is confirmed on-chain — so callers MUST reconcile against the live `ownerOf` before
 * trusting an entry (see GET /api/sub-ens/owned). In-memory map backed by a JSON file
 * so state survives restarts (same pattern as tx-registry.ts).
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), ".data");
const STORE_FILE = join(DATA_DIR, "sub-ens-owners.json");

/** lowercased address → set of labels claimed by that address */
const owners = new Map<string, Set<string>>();

let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(STORE_FILE, "utf-8");
    const obj = JSON.parse(raw) as Record<string, string[]>;
    for (const [addr, labels] of Object.entries(obj)) {
      owners.set(addr.toLowerCase(), new Set(labels));
    }
    console.log(`[sub-ens-owners] Loaded ${owners.size} owners from disk`);
  } catch {
    // File doesn't exist yet — fine
  }
}

function persistToDisk(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const obj: Record<string, string[]> = {};
    for (const [addr, labels] of owners) obj[addr] = [...labels];
    writeFileSync(STORE_FILE, JSON.stringify(obj), "utf-8");
  } catch (err) {
    console.error("[sub-ens-owners] Failed to persist to disk:", err);
  }
}

/** Record that `address` claimed `label` (idempotent). */
export function recordOwner(address: string, label: string): void {
  ensureLoaded();
  const addr = address.toLowerCase();
  const lbl = label.toLowerCase();
  let set = owners.get(addr);
  if (!set) { set = new Set(); owners.set(addr, set); }
  if (set.has(lbl)) return;
  set.add(lbl);
  persistToDisk();
}

/** Labels this address has claimed through WoCo (unreconciled — verify against chain). */
export function listOwnedLabels(address: string): string[] {
  ensureLoaded();
  return [...(owners.get(address.toLowerCase()) ?? [])];
}
