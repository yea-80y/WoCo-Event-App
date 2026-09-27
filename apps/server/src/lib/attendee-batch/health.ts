/**
 * `/api/health` `attendeeBatch` (#546). The attendee batch is on the money
 * path: when it cannot take an order, checkout refuses every sale, and when it
 * expires every order on it goes with it, live ones included. Red when sales
 * are refused, the TTL is under `POSTAGE_TTL_MIN_SECONDS` (default 7 days), the
 * fullest bucket is over `POSTAGE_UTILIZATION_MAX_PCT` (default 90) or a burn
 * was left unfinished.
 */

import { DEFAULT_TTL_MIN_SECONDS, DEFAULT_UTILIZATION_MAX_PCT } from "../health/alarms.js";
import { attendeeLedgerStatus } from "./ledger.js";
import { attendeeCheckoutRefusal } from "./writer.js";

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function attendeeBatchHealth(nowMs: number = Date.now()) {
  const ttlMinSeconds = positiveInt(process.env.POSTAGE_TTL_MIN_SECONDS, DEFAULT_TTL_MIN_SECONDS);
  const utilizationMaxPct = positiveInt(process.env.POSTAGE_UTILIZATION_MAX_PCT, DEFAULT_UTILIZATION_MAX_PCT);
  const status = attendeeLedgerStatus();
  const refusal = attendeeCheckoutRefusal();
  const active = status.batches.find((b) => b.batchId === status.active) ?? null;
  const ttlSeconds = active?.expiresAt ? Math.round((Date.parse(active.expiresAt) - nowMs) / 1000) : null;
  const fullestPct = active ? Math.round((active.fullestUsed / active.capacity) * 100) : null;
  const checks = {
    sales: refusal === null ? { ok: true } : { ok: false, reason: refusal },
    ttl:
      ttlSeconds !== null && ttlSeconds >= ttlMinSeconds
        ? { ok: true }
        : { ok: false, reason: ttlSeconds === null ? "no active batch expiry" : `expires in ${(ttlSeconds / 86400).toFixed(1)}d` },
    fullestBucket:
      fullestPct !== null && fullestPct <= utilizationMaxPct
        ? { ok: true }
        : { ok: false, reason: fullestPct === null ? "no active batch" : `fullest bucket ${active!.fullestUsed}/${active!.capacity}` },
    burns: status.burning === 0 ? { ok: true } : { ok: false, reason: `${status.burning} unfinished - re-run the burn` },
  };
  return {
    ok: Object.values(checks).every((c) => c.ok),
    readable: status.readable,
    active: status.active,
    expiresAt: active?.expiresAt ?? null,
    fullestUsed: active?.fullestUsed ?? null,
    capacity: active?.capacity ?? null,
    orders: status.orders,
    burning: status.burning,
    checks,
  };
}
