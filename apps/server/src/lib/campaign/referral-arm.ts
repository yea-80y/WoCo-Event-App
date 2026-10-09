/**
 * Armed referrals: confirm a referral the moment Stripe verifies the referee,
 * not whenever they next open the app (owner decision 2026-10-09).
 *
 * The issuer needs two facts only the referee's client knows - which feed holds
 * their statement and which referrer it names - and the referee is nowhere near
 * the app when Stripe's webhook says they are verified. So the client hands both
 * over when it writes the statement, and this keeps them until verification.
 *
 * A POINTER, NEVER A RECORD. Nothing here is believed: `confirmReferral`
 * re-reads the statement from that feed and refuses one that is absent or
 * retracted, exactly as it does for the referee's own request. That is why this
 * is not the pending table #476 deleted - it holds no claim the issuer acts on
 * unread. Losing the file loses only speed: the Home auto-confirm still credits
 * the referral on the referee's next visit.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../marketing/persist.js";
import { stripeVerificationComplete } from "../stripe/accounts.js";
import { confirmReferral, type ConfirmResult } from "./issuer.js";

const ARMS_FILE = join(process.cwd(), ".data", "referral-arms.json");

interface Arm {
  referrer: string;
  feed: string;
  at: string;
}

/** referee (lowercase) -> the statement to confirm when they verify. */
let arms: Record<string, Arm> = {};
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    arms = JSON.parse(readFileSync(ARMS_FILE, "utf-8"));
  } catch {
    // Absent is the normal first boot; unreadable costs only the speed above.
  }
}

function persist(): void {
  writeJsonAtomic(ARMS_FILE, arms, "referral-arms");
}

/**
 * The FIRST arm stands, the campaign's own rule: a referee who follows a second
 * invite has two statements on their feed, and the Home banner offers the
 * earlier one, so the server must not confirm the later one first.
 */
export function armReferral(referee: string, referrer: string, feed: string): void {
  ensureLoaded();
  const key = referee.toLowerCase();
  if (arms[key]) return;
  arms[key] = { referrer: referrer.toLowerCase(), feed: feed.toLowerCase(), at: new Date().toISOString() };
  persist();
}

export function armedReferral(referee: string): Arm | undefined {
  ensureLoaded();
  return arms[referee.toLowerCase()];
}

function disarm(referee: string): void {
  if (!arms[referee]) return;
  delete arms[referee];
  persist();
}

export type ArmOutcome = "none" | "not-verified" | "retry" | Exclude<ConfirmResult["status"], "unavailable">;

export interface ArmDeps {
  verified: (address: string) => boolean;
  confirm: (args: { referee: string; refereeFeed: string; referrer: string }) => Promise<ConfirmResult>;
}

const liveDeps: ArmDeps = { verified: stripeVerificationComplete, confirm: (args) => confirmReferral(args) };

/**
 * Confirm `referee`'s armed referral if they are verified. Safe to call on every
 * verified write: with nothing armed it is a map lookup.
 *
 * Every answer but `unavailable` ends the arm - confirmed, already confirmed
 * (to anyone), no statement, retracted - because none of them changes on a
 * retry. `unavailable` keeps it for the next `account.updated` or the Home
 * backstop.
 */
export async function confirmArmedReferral(referee: string, deps: ArmDeps = liveDeps): Promise<ArmOutcome> {
  const key = referee.toLowerCase();
  const arm = armedReferral(key);
  if (!arm) return "none";
  if (!deps.verified(key)) return "not-verified";
  let result: ConfirmResult;
  try {
    result = await deps.confirm({ referee: key, refereeFeed: arm.feed, referrer: arm.referrer });
  } catch (err) {
    console.warn(`[campaign] armed confirm threw for ${key}:`, err);
    return "retry";
  }
  if (result.status === "unavailable") return "retry";
  disarm(key);
  console.log(`[campaign] armed referral for ${key} -> ${result.status}`);
  return result.status;
}

/** Test seam. */
export function resetArmsForTest(): void {
  arms = {};
  loaded = true;
}
