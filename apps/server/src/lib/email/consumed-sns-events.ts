/**
 * SNS event registry — exactly-once processing across SNS retries.
 *
 * Keyed by `MessageId`, which is stable across redeliveries. SNS retries an
 * HTTPS endpoint that does not return 2xx, so without this a slow response
 * turns one complaint into several suppression writes; the writes are
 * idempotent today, but relying on that would make any future non-idempotent
 * handling silently wrong.
 *
 * BOUNDED, unlike `consumed-resend-events.json`, which grows forever. Every
 * bounce and complaint for the life of the platform passes through here, so an
 * uncapped set is a slow memory and disk leak. A FIFO cap is safe because SNS
 * gives up retrying long before an id ages out of a window this size.
 *
 * MUST survive restarts — same class as consumed-tx-hashes.json.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../marketing/persist.js";

const STORE_FILE = join(process.cwd(), ".data", "consumed-sns-events.json");
const MAX_IDS = 20_000;

/** Insertion-ordered, which is what makes the FIFO eviction below correct. */
let consumed = new Set<string>();
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const arr = JSON.parse(readFileSync(STORE_FILE, "utf-8")) as string[];
    if (Array.isArray(arr)) consumed = new Set(arr);
  } catch {
    // File doesn't exist yet — that's fine.
  }
}

/** True if this id is new (and is now consumed); false on redelivery. */
export function checkAndConsumeSnsEvent(id: string): boolean {
  ensureLoaded();
  if (consumed.has(id)) return false;
  consumed.add(id);
  if (consumed.size > MAX_IDS) {
    // Drop the oldest 10% in one pass rather than one per insert, so a busy
    // period does not rewrite the whole file on every single event.
    const drop = Math.ceil(MAX_IDS * 0.1);
    const it = consumed.values();
    for (let i = 0; i < drop; i++) {
      const next = it.next();
      if (next.done) break;
      consumed.delete(next.value);
    }
  }
  writeJsonAtomic(STORE_FILE, [...consumed], "consumed-sns-events");
  return true;
}

/** Tests only. */
export function _resetForTest(): void {
  consumed = new Set();
  loaded = false;
}
