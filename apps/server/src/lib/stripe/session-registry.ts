/**
 * Stripe session registry — prevents duplicate processing of webhook events.
 *
 * Stripe retries failed webhooks; both the platform and connected-accounts
 * webhooks can also deliver the same checkout.session.completed for the same
 * payment. Without this guard, the second delivery would try to claim an
 * already-claimed ticket and trigger an erroneous auto-refund.
 *
 * In-memory Set backed by a JSON file so state survives restarts.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), ".data");
const REGISTRY_FILE = join(DATA_DIR, "consumed-stripe-sessions.json");

const consumed = new Set<string>();
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(REGISTRY_FILE, "utf-8");
    const arr = JSON.parse(raw) as string[];
    for (const id of arr) consumed.add(id);
    console.log(`[stripe-session-registry] Loaded ${consumed.size} consumed session IDs from disk`);
  } catch {
    // File doesn't exist yet — first run
  }
}

function persistToDisk(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(REGISTRY_FILE, JSON.stringify([...consumed]), "utf-8");
  } catch (err) {
    console.error("[stripe-session-registry] Failed to persist to disk:", err);
  }
}

/**
 * Atomically check and consume a Stripe session ID.
 * Returns true if this is the first time we've seen this session (proceed).
 * Returns false if we've already processed it (skip — duplicate delivery).
 */
export function checkAndConsumeSession(sessionId: string): boolean {
  ensureLoaded();
  if (consumed.has(sessionId)) {
    return false;
  }
  consumed.add(sessionId);
  persistToDisk();
  return true;
}
