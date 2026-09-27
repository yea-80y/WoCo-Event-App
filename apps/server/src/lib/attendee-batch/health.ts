/**
 * `/api/health` `attendeeBatch` (#546). The attendee batch is on the money
 * path: when it cannot take an order, checkout refuses every sale, and when it
 * expires every order on it goes with it, live ones included. Red when sales
 * are refused, the TTL is under `POSTAGE_TTL_MIN_SECONDS` (default 7 days), the
 * fullest bucket has few free slots left, or a burn was left unfinished.
 *
 * The bucket check counts FREE SLOTS, not a percentage: this batch refuses an
 * order the moment one of its chunks meets a full bucket, and at depth 20 a
 * 90% line is 15 of 16 slots, which leaves little notice. Red at a quarter of
 * a bucket left (at most 4 slots): ~150k chunks of notice at depth 20.
 */

import { DEFAULT_TTL_MIN_SECONDS } from "../health/alarms.js";
import { attendeeLedgerStatus } from "./ledger.js";
import { attendeeCheckoutRefusal } from "./writer.js";

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function attendeeBatchHealth(nowMs: number = Date.now()) {
  const ttlMinSeconds = positiveInt(process.env.POSTAGE_TTL_MIN_SECONDS, DEFAULT_TTL_MIN_SECONDS);
  const status = attendeeLedgerStatus();
  const refusal = attendeeCheckoutRefusal();
  const active = status.batches.find((b) => b.batchId === status.active) ?? null;
  const ttlSeconds = active?.expiresAt ? Math.round((Date.parse(active.expiresAt) - nowMs) / 1000) : null;
  const freeSlots = active ? active.capacity - active.fullestUsed : null;
  const freeFloor = active ? Math.min(4, Math.floor(active.capacity / 4)) : 0;
  const checks = {
    sales: refusal === null ? { ok: true } : { ok: false, reason: refusal },
    ttl:
      ttlSeconds !== null && ttlSeconds >= ttlMinSeconds
        ? { ok: true }
        : { ok: false, reason: ttlSeconds === null ? "no active batch expiry" : `expires in ${(ttlSeconds / 86400).toFixed(1)}d` },
    fullestBucket:
      freeSlots !== null && freeSlots > freeFloor
        ? { ok: true }
        : { ok: false, reason: freeSlots === null ? "no active batch" : `fullest bucket ${active!.fullestUsed}/${active!.capacity}` },
    burns: status.burning === 0 ? { ok: true } : { ok: false, reason: `${status.burning} unfinished - re-run the burn` },
  };
  return {
    ok: Object.values(checks).every((c) => c.ok),
    readable: status.readable,
    active: status.active,
    expiresAt: active?.expiresAt ?? null,
    fullestUsed: active?.fullestUsed ?? null,
    capacity: active?.capacity ?? null,
    bucketsFull: active?.bucketsFull ?? null,
    bucketFullRefusals: status.bucketFullRefusals,
    orders: status.orders,
    burning: status.burning,
    checks,
  };
}
