/**
 * Payout intent journal — the write-ahead record that makes a payout exactly-once.
 *
 * "Same selected set ⇒ same idempotency key" is only crash-safe while the set is
 * stable. If a crash lands between the Stripe call and the ledger write and a NEW
 * entry becomes due before the next sweep, the re-selected set differs, the key
 * differs, and the original entries are paid a second time. The journal closes
 * that: the exact set, amount and key are persisted BEFORE Stripe is called, and
 * the next sweep must settle the pending intent — confirm (found on Stripe),
 * replay (same key, inside Stripe's 24h idempotency window), or abandon (provably
 * absent after the window) — before any new selection happens for that
 * account+currency.
 *
 * At most one intent per account+currency, because the sweep creates at most one
 * payout per group per run. MUST survive restarts, same as the ledger it protects.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), ".data");
const INTENTS_FILE = join(DATA_DIR, "stripe-payout-intents.json");

export interface PayoutIntent {
  stripeAccountId: string;
  /** The PAYOUT currency — settlement, not necessarily presentment. Lowercase. */
  currency: string;
  /** The exact entry set this payout covers. Replayed verbatim, never rebuilt. */
  sessionIds: string[];
  /** Subset of sessionIds that were ceiling-forced, for the ledger flags. */
  forcedSessionIds: string[];
  /** Minor units — the sum of the set's resolved nets at selection time. */
  amount: number;
  idempotencyKey: string;
  createdAt: string;
}

/** `${stripeAccountId}|${currency}` → intent */
let store: Record<string, PayoutIntent> = {};
let loaded = false;

function keyFor(stripeAccountId: string, currency: string): string {
  return `${stripeAccountId}|${currency.toLowerCase()}`;
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    store = JSON.parse(readFileSync(INTENTS_FILE, "utf-8")) as Record<string, PayoutIntent>;
    const n = Object.keys(store).length;
    if (n > 0) console.warn(`[payout-intents] ${n} unsettled payout intent(s) on disk — recovery will run`);
  } catch {
    // No journal yet — first run.
  }
}

function persist(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    // Write-then-rename, 0600: same rationale as the ledger — a truncated journal
    // would erase the record of an in-flight payout, which is the one state this
    // file exists to remember.
    const tmp = `${INTENTS_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, INTENTS_FILE);
  } catch (err) {
    console.error("[payout-intents] Failed to persist:", err);
  }
}

export function getIntent(stripeAccountId: string, currency: string): PayoutIntent | undefined {
  ensureLoaded();
  return store[keyFor(stripeAccountId, currency)];
}

export function listIntents(): PayoutIntent[] {
  ensureLoaded();
  return Object.values(store);
}

export function saveIntent(intent: PayoutIntent): void {
  ensureLoaded();
  store[keyFor(intent.stripeAccountId, intent.currency)] = intent;
  persist();
}

export function clearIntent(stripeAccountId: string, currency: string): void {
  ensureLoaded();
  delete store[keyFor(stripeAccountId, currency)];
  persist();
}

/** Test seam — resets in-memory state so a fresh file is read. */
export function __resetForTests(): void {
  store = {};
  loaded = false;
}
