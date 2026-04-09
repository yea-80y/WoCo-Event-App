/**
 * Session revocation — server-side nonce blacklist.
 *
 * Two revocation modes:
 * 1. Single session: revoke by nonce (invalidates one delegation)
 * 2. All sessions: revoke by parent address + timestamp (invalidates all
 *    delegations issued before that time)
 *
 * Backed by a JSON file so state survives server restarts.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), ".data");
const REVOCATION_FILE = join(DATA_DIR, "revoked-sessions.json");

interface RevocationState {
  /** Set of revoked session nonces */
  nonces: string[];
  /** Per-address "revoke all before" timestamps (ISO strings) */
  revokeAllBefore: Record<string, string>;
}

let state: RevocationState = { nonces: [], revokeAllBefore: {} };
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(REVOCATION_FILE, "utf-8");
    state = JSON.parse(raw) as RevocationState;
    console.log(`[revocation] Loaded ${state.nonces.length} revoked nonces`);
  } catch {
    // File doesn't exist yet
  }
}

function persist(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(REVOCATION_FILE, JSON.stringify(state), "utf-8");
  } catch (err) {
    console.error("[revocation] Failed to persist:", err);
  }
}

/** Check if a session nonce has been revoked */
export function isSessionRevoked(nonce: string, parentAddress: string, issuedAt: string): boolean {
  ensureLoaded();

  // Check individual nonce revocation
  if (state.nonces.includes(nonce)) return true;

  // Check "revoke all before" for this parent address
  const revokeBeforeStr = state.revokeAllBefore[parentAddress.toLowerCase()];
  if (revokeBeforeStr) {
    const revokeBefore = new Date(revokeBeforeStr).getTime();
    const issued = new Date(issuedAt).getTime();
    if (issued <= revokeBefore) return true;
  }

  return false;
}

/** Revoke a single session by nonce */
export function revokeSession(nonce: string): void {
  ensureLoaded();
  if (!state.nonces.includes(nonce)) {
    state.nonces.push(nonce);
    persist();
    console.log(`[revocation] Session revoked: ${nonce}`);
  }
}

/** Revoke all sessions for a parent address issued before now */
export function revokeAllSessions(parentAddress: string): void {
  ensureLoaded();
  state.revokeAllBefore[parentAddress.toLowerCase()] = new Date().toISOString();
  persist();
  console.log(`[revocation] All sessions revoked for ${parentAddress}`);
}
