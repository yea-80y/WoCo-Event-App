/**
 * Referral store — pending attributions + confirmed projection.
 *
 * PENDING is genuinely server-held state (the pre-chain attribution window):
 * captured at signup-via-link, consumed when the merchant's attestation lands
 * on-chain. CONFIRMED is a projection of on-chain EAS truth (same posture as
 * likes-index: cache, not trust anchor — rebuildable from Attested logs).
 *
 * One referral per referee, ever: first pending wins, a confirmed referral is
 * permanent (the attestation is non-revocable). Keyed by lowercase referee.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Hex0x, ReferralRecord } from "@woco/shared";

const DATA_DIR = join(process.cwd(), ".data");
const STORE_FILE = join(DATA_DIR, "referrals.json");

export interface PendingReferral {
  referee: Hex0x;
  referrer: Hex0x;
  createdAt: string;
}

interface StoreShape {
  pending: Record<string, PendingReferral>;
  confirmed: Record<string, ReferralRecord>;
}

let store: StoreShape = { pending: {}, confirmed: {} };
let loaded = false;

const lower = (s: string) => s.toLowerCase() as Hex0x;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    store = JSON.parse(readFileSync(STORE_FILE, "utf-8")) as StoreShape;
    console.log(
      `[referrals] Loaded ${Object.keys(store.pending).length} pending / ${Object.keys(store.confirmed).length} confirmed from disk`,
    );
  } catch {
    // File doesn't exist yet — fine.
  }
}

function persist(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STORE_FILE, JSON.stringify(store), "utf-8");
  } catch (err) {
    console.error("[referrals] Failed to persist to disk:", err);
  }
}

export function getPendingReferral(referee: string): PendingReferral | undefined {
  ensureLoaded();
  return store.pending[lower(referee)];
}

export function getConfirmedReferral(referee: string): ReferralRecord | undefined {
  ensureLoaded();
  return store.confirmed[lower(referee)];
}

/** First attribution wins; no-ops (returns false) if any referral exists. */
export function setPendingReferral(referee: string, referrer: string): boolean {
  ensureLoaded();
  const key = lower(referee);
  if (store.pending[key] || store.confirmed[key]) return false;
  store.pending[key] = {
    referee: key,
    referrer: lower(referrer),
    createdAt: new Date().toISOString(),
  };
  persist();
  return true;
}

/** Promote to confirmed (chain-verified by the caller) and drop the pending. */
export function confirmReferral(record: ReferralRecord): void {
  ensureLoaded();
  const key = lower(record.referee);
  delete store.pending[key];
  store.confirmed[key] = {
    referrer: lower(record.referrer),
    referee: key,
    uid: lower(record.uid),
    time: record.time,
  };
  persist();
}

/** Confirmed referrals credited to one referrer (their earnings basis). */
export function getReferralsByReferrer(referrer: string): ReferralRecord[] {
  ensureLoaded();
  const r = lower(referrer);
  return Object.values(store.confirmed).filter((rec) => rec.referrer === r);
}
