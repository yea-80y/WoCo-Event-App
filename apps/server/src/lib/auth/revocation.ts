/**
 * Session revocation — server-side nonce blacklist.
 *
 * Two revocation modes:
 * 1. Single session: revoke by nonce (invalidates one delegation)
 * 2. All sessions: revoke by parent address + timestamp (invalidates all
 *    delegations issued before that time)
 *
 * Backed by a JSON file so state survives server restarts.
 *
 * GC: revoked nonces carry their session `expiresAt`. Once that timestamp
 * passes, the server would reject the delegation anyway (expiry check in
 * verify-delegation.ts), so the revocation entry is dead weight. We prune
 * on load and periodically in-memory so the file doesn't grow unbounded.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SESSION_EXPIRY_MS } from "@woco/shared";

const DATA_DIR = join(process.cwd(), ".data");
const REVOCATION_FILE = join(DATA_DIR, "revoked-sessions.json");

/** How often to sweep expired revocations while the process runs. */
const GC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

interface RevokedNonce {
  nonce: string;
  /** ISO timestamp when the underlying session expires (revocation is pointless after this). */
  expiresAt: string;
}

interface RevocationState {
  version: 1;
  nonces: RevokedNonce[];
  /** Per-address "revoke all before" timestamps (ISO strings) */
  revokeAllBefore: Record<string, string>;
}

// Legacy (pre-2026-04-09) format: `nonces` was `string[]` with no expiry data.
interface LegacyRevocationState {
  nonces: string[];
  revokeAllBefore: Record<string, string>;
}

let state: RevocationState = { version: 1, nonces: [], revokeAllBefore: {} };
// Index for O(1) lookup. Rebuilt from `state.nonces` on load / after prune.
let nonceIndex = new Set<string>();
let loaded = false;
let gcTimer: NodeJS.Timeout | null = null;

function rebuildIndex(): void {
  nonceIndex = new Set(state.nonces.map((n) => n.nonce));
}

/** Drop nonces whose underlying session has already expired. Returns number pruned. */
function pruneExpired(): number {
  const now = Date.now();
  const before = state.nonces.length;
  state.nonces = state.nonces.filter(
    (n) => new Date(n.expiresAt).getTime() > now,
  );
  const pruned = before - state.nonces.length;
  if (pruned > 0) {
    rebuildIndex();
  }
  return pruned;
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(REVOCATION_FILE, "utf-8");
    const parsed = JSON.parse(raw) as RevocationState | LegacyRevocationState;

    if ("version" in parsed && parsed.version === 1) {
      state = parsed;
    } else {
      // Legacy migration: we don't know the original session expiry,
      // so assume the worst case — one full SESSION_EXPIRY_MS from now.
      // The nonce will be dropped after that window at the latest.
      const fallbackExpiry = new Date(Date.now() + SESSION_EXPIRY_MS).toISOString();
      const legacy = parsed as LegacyRevocationState;
      state = {
        version: 1,
        nonces: legacy.nonces.map((nonce) => ({ nonce, expiresAt: fallbackExpiry })),
        revokeAllBefore: legacy.revokeAllBefore ?? {},
      };
      console.log(
        `[revocation] Migrated ${state.nonces.length} legacy revoked nonces (assumed expiry ${fallbackExpiry})`,
      );
      persist();
    }

    const pruned = pruneExpired();
    rebuildIndex();
    console.log(
      `[revocation] Loaded ${state.nonces.length} revoked nonces` +
        (pruned > 0 ? ` (pruned ${pruned} expired on load)` : ""),
    );
    if (pruned > 0) persist();
  } catch {
    // File doesn't exist yet — fresh state.
  }

  // Kick off periodic GC (no-op if timers unavailable in the environment).
  if (!gcTimer && typeof setInterval === "function") {
    gcTimer = setInterval(() => {
      const pruned = pruneExpired();
      if (pruned > 0) {
        console.log(`[revocation] GC pruned ${pruned} expired nonces`);
        persist();
      }
    }, GC_INTERVAL_MS);
    // Don't keep the event loop alive for GC alone.
    if (typeof gcTimer.unref === "function") gcTimer.unref();
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

  // Check individual nonce revocation (O(1) via Set).
  if (nonceIndex.has(nonce)) return true;

  // Check "revoke all before" for this parent address
  const revokeBeforeStr = state.revokeAllBefore[parentAddress.toLowerCase()];
  if (revokeBeforeStr) {
    const revokeBefore = new Date(revokeBeforeStr).getTime();
    const issued = new Date(issuedAt).getTime();
    if (issued <= revokeBefore) return true;
  }

  return false;
}

/**
 * Revoke a single session by nonce.
 * `expiresAt` is the session's own expiry — the revocation entry is GC'd
 * after that time (the delegation is rejected for being stale anyway).
 */
export function revokeSession(nonce: string, expiresAt: string): void {
  ensureLoaded();
  if (nonceIndex.has(nonce)) return;
  state.nonces.push({ nonce, expiresAt });
  nonceIndex.add(nonce);
  persist();
  console.log(`[revocation] Session revoked: ${nonce} (expires ${expiresAt})`);
}

/** Revoke all sessions for a parent address issued before now */
export function revokeAllSessions(parentAddress: string): void {
  ensureLoaded();
  state.revokeAllBefore[parentAddress.toLowerCase()] = new Date().toISOString();
  persist();
  console.log(`[revocation] All sessions revoked for ${parentAddress}`);
}
