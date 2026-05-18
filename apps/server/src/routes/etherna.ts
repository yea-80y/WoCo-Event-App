/**
 * Etherna user-batch endpoints.
 *
 *   POST /api/etherna/purchase-batch  — auth-gated, provisions a per-user batch
 *   GET  /api/etherna/my-batch        — auth-gated, returns user's batch or null
 */

import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.js";
import { getUserBatch, saveUserBatch, provisionEthernaBatch } from "../lib/etherna/batches.js";

const ETHERNA_GW = process.env.ETHERNA_GATEWAY_URL || "https://gateway.etherna.io";

function defaultDepth(): number {
  return Number(process.env.ETHERNA_USER_BATCH_DEPTH ?? "19");
}
function defaultTtlDays(): number {
  return Number(process.env.ETHERNA_USER_BATCH_TTL_DAYS ?? "30");
}
function defaultMarginPct(): number {
  return Number(process.env.ETHERNA_USER_BATCH_MARGIN_PCT ?? "25");
}
function maxXDai(): number {
  return Number(process.env.ETHERNA_PURCHASE_MAX_XDAI ?? "0.5");
}

const ethernaRoutes = new Hono();

ethernaRoutes.get("/my-batch", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const entry = getUserBatch(parentAddress);
  return c.json({ ok: true, data: entry ?? null });
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
    const body = await c.req.json().catch(() => ({})) as { depth?: number; ttlDays?: number };
    const depth = body.depth ?? defaultDepth();
    const ttlDays = body.ttlDays ?? defaultTtlDays();

    const result = await provisionEthernaBatch({
      depth,
      ttlDays,
      marginPct: defaultMarginPct(),
      maxXDai: maxXDai(),
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

    console.log(`[etherna] provisioned batch ${result.batchId.slice(0, 12)}… for ${parentAddress} (debit ${result.debitXDai} xDai)`);

    return c.json({
      ok: true,
      data: { batchId: result.batchId, expiresAt: result.expiresAt, debit: result.debitXDai },
    });
  } catch (err) {
    console.error("[etherna/purchase-batch]", err);
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Purchase failed" }, 500);
  }
});

export { ethernaRoutes };
