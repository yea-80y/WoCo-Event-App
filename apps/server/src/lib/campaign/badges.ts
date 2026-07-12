/**
 * Cohort badge issuer + projection.
 *
 * Badges are issued LAZILY on a user's first meaningful action (claim, event
 * publish, confirmed referral) — never on raw signup, so bot-farmed profiles
 * can't mint epoch-0 badges (project_referral_campaign policy). Issuance is
 * platform-attested on-chain via the sponsor key; this store is the fast read
 * projection (rebuildable from Attested logs for our schema, attester =
 * sponsor).
 *
 * `issueJoinedBadge` is safe to call fire-and-forget from any success path:
 * it dedups against the projection AND an in-flight set, and never throws.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BadgeRecord, Hex0x } from "@woco/shared";
import { BadgeType, EARLY_ADOPTER_EPOCH } from "@woco/shared";
import { attestJoinedBadge } from "./eas-campaign.js";

const DATA_DIR = join(process.cwd(), ".data");
const STORE_FILE = join(DATA_DIR, "badges-index.json");

let badges: Record<string, BadgeRecord> = {};
let loaded = false;

const lower = (s: string) => s.toLowerCase() as Hex0x;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    badges = JSON.parse(readFileSync(STORE_FILE, "utf-8")) as Record<string, BadgeRecord>;
    console.log(`[badges] Loaded ${Object.keys(badges).length} badges from disk`);
  } catch {
    // File doesn't exist yet — fine.
  }
}

function persist(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STORE_FILE, JSON.stringify(badges), "utf-8");
  } catch (err) {
    console.error("[badges] Failed to persist to disk:", err);
  }
}

export function getBadge(address: string): BadgeRecord | undefined {
  ensureLoaded();
  return badges[lower(address)];
}

/** The platform-defined campaign window; epoch 0 = early adopter. */
export function currentEpoch(): number {
  const raw = process.env.CAMPAIGN_EPOCH;
  const n = raw === undefined ? EARLY_ADOPTER_EPOCH : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : EARLY_ADOPTER_EPOCH;
}

const inFlight = new Set<string>();

/**
 * Issue the Joined badge for `address` in the current epoch, once ever.
 * Fire-and-forget safe: dedups and swallows errors (a failed issue retries on
 * the user's next qualifying action).
 */
export async function issueJoinedBadge(address: string): Promise<void> {
  ensureLoaded();
  const key = lower(address);
  if (!/^0x[0-9a-f]{40}$/.test(key)) return;
  if (badges[key] || inFlight.has(key)) return;
  inFlight.add(key);
  try {
    const epoch = currentEpoch();
    const { uid, time } = await attestJoinedBadge(key, epoch);
    badges[key] = { recipient: key, badgeType: BadgeType.Joined, epoch, uid, time };
    persist();
    console.log(`[badges] Joined badge issued: ${key} epoch=${epoch} uid=${uid}`);
  } catch (err) {
    console.error(`[badges] Failed to issue badge for ${key}:`, err);
  } finally {
    inFlight.delete(key);
  }
}
