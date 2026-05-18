/**
 * Etherna user-batch endpoints.
 *
 *   POST /api/etherna/purchase-batch  — auth-gated, provisions a per-user batch
 *   GET  /api/etherna/my-batch        — auth-gated, returns user's batch or null
 */

import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.js";
import {
  getUserBatch,
  saveUserBatch,
  provisionEthernaBatch,
  estimateEthernaBatch,
} from "../lib/etherna/batches.js";

const ETHERNA_GW = process.env.ETHERNA_GATEWAY_URL || "https://gateway.etherna.io";

function defaultDepth(): number {
  return Number(process.env.ETHERNA_USER_BATCH_DEPTH ?? "19");
}
function defaultTtlDays(): number {
  return Number(process.env.ETHERNA_USER_BATCH_TTL_DAYS ?? "1.1");
}
function defaultMarginPct(): number {
  return Number(process.env.ETHERNA_USER_BATCH_MARGIN_PCT ?? "25");
}
function maxBZZ(): number {
  return Number(process.env.ETHERNA_PURCHASE_MAX_BZZ ?? "0.5");
}

const ethernaRoutes = new Hono();

ethernaRoutes.get("/my-batch", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const entry = getUserBatch(parentAddress);
  return c.json({ ok: true, data: entry ?? null });
});

/** Preview of what /purchase-batch would commit, using server-side env defaults.
 *  Lets the UI show depth/TTL/estimate without the client carrying those values. */
ethernaRoutes.get("/purchase-preview", requireAuth, async (c) => {
  try {
    const depth = defaultDepth();
    const ttlDays = defaultTtlDays();
    const est = await estimateEthernaBatch({ depth, ttlDays, marginPct: defaultMarginPct() });
    return c.json({
      ok: true,
      data: {
        depth,
        ttlDays,
        marginPct: est.marginPct,
        estimatedBZZ: est.estimatedBZZ,
        maxBZZ: maxBZZ(),
      },
    });
  } catch (err) {
    console.error("[etherna/purchase-preview]", err);
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Preview failed" }, 500);
  }
});

ethernaRoutes.post("/purchase-batch", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();

  if (process.env.BATCH_PER_USER_AUTO_PROVISION === "false") {
    return c.json({ ok: false, error: "Per-user batch provisioning disabled" }, 403);
  }

  const existing = getUserBatch(parentAddress);
  if (existing) {
    return c.json({
      ok: true,
      data: { batchId: existing.batchId, expiresAt: existing.expiresAt, debit: "0" },
    });
  }

  try {
    const depth = defaultDepth();
    const ttlDays = defaultTtlDays();

    const result = await provisionEthernaBatch({
      depth,
      ttlDays,
      marginPct: defaultMarginPct(),
      maxBZZ: maxBZZ(),
      label: `woco-user-${parentAddress.slice(2, 10)}-${Date.now()}`,
    });

    const paidUntil = new Date(Date.now() + 365 * 86_400_000).toISOString();

    saveUserBatch(parentAddress, {
      batchId: result.batchId,
      depth,
      ttlDays,
      purchasedAt: result.purchasedAt,
      expiresAt: result.expiresAt,
      paidUntil,
      gateway: ETHERNA_GW,
    });

    console.log(`[etherna] provisioned batch ${result.batchId.slice(0, 12)}… for ${parentAddress} (depth=${depth}, ttl=${ttlDays}d, debit ${result.debitXDai} xDai, committed ${result.estimatedBZZ} BZZ)`);

    return c.json({
      ok: true,
      data: {
        batchId: result.batchId,
        expiresAt: result.expiresAt,
        debit: result.debitXDai,
        estimatedBZZ: result.estimatedBZZ,
      },
    });
  } catch (err) {
    console.error("[etherna/purchase-batch]", err);
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Purchase failed" }, 500);
  }
});

export { ethernaRoutes };
