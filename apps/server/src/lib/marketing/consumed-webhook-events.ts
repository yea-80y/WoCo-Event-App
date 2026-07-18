/**
 * Resend webhook event registry — exactly-once processing across retries.
 * Keyed by the svix-id header (stable per event across redeliveries).
 * Same pattern as consumed-tx-hashes / consumed-stripe-sessions; MUST
 * survive restarts.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), ".data");
const REGISTRY_FILE = join(DATA_DIR, "consumed-resend-events.json");

const consumed = new Set<string>();
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(REGISTRY_FILE, "utf-8");
    const arr = JSON.parse(raw) as string[];
    for (const id of arr) consumed.add(id);
  } catch {
    // File doesn't exist yet — that's fine
  }
}

function persistToDisk(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(REGISTRY_FILE, JSON.stringify([...consumed]), "utf-8");
  } catch (err) {
    console.error("[resend-events] Failed to persist to disk:", err);
  }
}

/** True if this event id is new (now consumed); false on redelivery. */
export function checkAndConsumeWebhookEvent(id: string): boolean {
  ensureLoaded();
  if (consumed.has(id)) return false;
  consumed.add(id);
  persistToDisk();
  return true;
}
