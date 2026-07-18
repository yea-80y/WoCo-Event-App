/**
 * Per-organiser rolling 24h marketing send cap — the ramp-up guard that keeps
 * a fresh sender from blasting a cold imported list in one go (domain
 * reputation protection; Gmail/Yahoo enforce complaint rates, we enforce
 * volume). File-backed so restarts can't reset the window.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), ".data");
const STORE_FILE = join(DATA_DIR, "marketing-send-log.json");

const WINDOW_MS = 24 * 60 * 60 * 1000;

interface SendLogEntry {
  ts: number;
  count: number;
}

const log = new Map<string, SendLogEntry[]>();
let loaded = false;

function dailyCap(): number {
  const n = Number(process.env.MARKETING_DAILY_CAP);
  return Number.isFinite(n) && n > 0 ? n : 2000;
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
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STORE_FILE, JSON.stringify(Object.fromEntries(log)), "utf-8");
  } catch (err) {
    console.error("[send-cap] Failed to persist to disk:", err);
  }
}

function recentEntries(organiserAddress: string): SendLogEntry[] {
  ensureLoaded();
  const org = organiserAddress.toLowerCase();
  const cutoff = Date.now() - WINDOW_MS;
  const recent = (log.get(org) ?? []).filter((e) => e.ts > cutoff);
  log.set(org, recent);
  return recent;
}

export function capRemaining(organiserAddress: string): number {
  const used = recentEntries(organiserAddress).reduce((sum, e) => sum + e.count, 0);
  return Math.max(0, dailyCap() - used);
}

export function recordSend(organiserAddress: string, count: number): void {
  if (count <= 0) return;
  const recent = recentEntries(organiserAddress);
  recent.push({ ts: Date.now(), count });
  log.set(organiserAddress.toLowerCase(), recent);
  persistToDisk();
}
