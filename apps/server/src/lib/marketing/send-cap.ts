/**
 * Per-organiser rolling 24h marketing send cap — the ramp-up guard that keeps
 * a fresh sender from blasting a cold imported list in one go (domain
 * reputation protection; Gmail/Yahoo enforce complaint rates, we enforce
 * volume). File-backed so restarts can't reset the window.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./persist.js";

const DATA_DIR = join(process.cwd(), ".data");
const STORE_FILE = join(DATA_DIR, "marketing-send-log.json");

const WINDOW_MS = 24 * 60 * 60 * 1000;

interface SendLogEntry {
  ts: number;
  count: number;
  /**
   * Set when the entry is a RESERVATION made by a background broadcast job,
   * so the same entry can later be corrected to what the job actually sent.
   */
  jobId?: string;
}

const log = new Map<string, SendLogEntry[]>();
let loaded = false;

function envDailyCap(): number {
  const n = Number(process.env.MARKETING_DAILY_CAP);
  return Number.isFinite(n) && n > 0 ? n : 2000;
}

/**
 * A cap below the organiser's own list size is not a reputation guard, it is a
 * product defect — it makes announcing an event impossible for anyone whose
 * audience outgrew the flat default. Callers pass their stored list size as the
 * floor so one full-list send per 24h is always permitted.
 *
 * At the entitlements step this floor becomes the tier's contact allowance
 * (docs/PRICING_AND_EMAIL.md §14 E5); the env var stays as the default for
 * organisers with no tier record.
 */
function effectiveDailyCap(minimumCap?: number): number {
  return Math.max(envDailyCap(), minimumCap ?? 0);
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(STORE_FILE, "utf-8");
    const obj = JSON.parse(raw) as Record<string, SendLogEntry[]>;
    for (const [org, arr] of Object.entries(obj)) log.set(org, arr);
  } catch {
    // File doesn't exist yet — that's fine
  }
}

function persistToDisk(): void {
  writeJsonAtomic(STORE_FILE, Object.fromEntries(log), "send-cap");
}

function recentEntries(organiserAddress: string): SendLogEntry[] {
  ensureLoaded();
  const org = organiserAddress.toLowerCase();
  const cutoff = Date.now() - WINDOW_MS;
  const recent = (log.get(org) ?? []).filter((e) => e.ts > cutoff);
  log.set(org, recent);
  return recent;
}

export function capRemaining(organiserAddress: string, minimumCap?: number): number {
  const used = recentEntries(organiserAddress).reduce((sum, e) => sum + e.count, 0);
  return Math.max(0, effectiveDailyCap(minimumCap) - used);
}

export function recordSend(organiserAddress: string, count: number): void {
  if (count <= 0) return;
  const recent = recentEntries(organiserAddress);
  recent.push({ ts: Date.now(), count });
  log.set(organiserAddress.toLowerCase(), recent);
  persistToDisk();
}

/**
 * Claim allowance for a broadcast that has not run yet.
 *
 * A background job drains for up to an hour, so the cap has to bind BEFORE the
 * send starts — checking it after would let two concurrent jobs each pass a
 * check the other invalidates. The reservation is therefore the full accepted
 * recipient count, which over-states what will actually go out (suppressed
 * recipients never receive anything).
 *
 * `reconcileReservation` is what stops that over-statement becoming permanent,
 * and it is not optional. Without it a job killed at 5% progress leaves a
 * 20,000 reservation standing, `capRemaining` returns 0, and the organiser is
 * locked out of resuming for 24 hours — the accounting for a failure blocking
 * the remedy for that same failure.
 */
export function reserveSend(organiserAddress: string, count: number, jobId: string): void {
  if (count <= 0) return;
  const recent = recentEntries(organiserAddress);
  recent.push({ ts: Date.now(), count, jobId });
  log.set(organiserAddress.toLowerCase(), recent);
  persistToDisk();
}

/**
 * Correct a reservation down to what the job really sent.
 *
 * Rewrites the original entry in place rather than appending a negative one: a
 * refund written an hour after the reservation would also AGE OUT an hour
 * later, briefly granting allowance that was never earned.
 *
 * @returns true if a reservation was found and corrected.
 */
export function reconcileReservation(
  organiserAddress: string,
  jobId: string,
  actualSent: number,
): boolean {
  const recent = recentEntries(organiserAddress);
  const entry = recent.find((e) => e.jobId === jobId);
  if (!entry) return false;
  entry.count = Math.max(0, actualSent);
  log.set(organiserAddress.toLowerCase(), recent);
  persistToDisk();
  return true;
}
