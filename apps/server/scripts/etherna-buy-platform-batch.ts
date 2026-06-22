/**
 * One-shot: buy the shared Etherna PLATFORM batch (event-page deploys for users
 * with no batch of their own). depth 19, 30-day TTL, 10% margin (~33d effective).
 * Mutable — Etherna doesn't support immutable; dilute later when needed.
 *
 *   node --env-file=.env --import tsx scripts/etherna-buy-platform-batch.ts
 *
 * Reads the batch back from Etherna to confirm depth + TTL + usable before we
 * trust the client-side math. Prints the id for ETHERNA_PLATFORM_BATCH.
 */
import { provisionEthernaBatch, estimateEthernaBatch } from "../src/lib/etherna/batches.js";
import { ensureEthernaToken, getCachedEthernaToken } from "../src/lib/etherna/auth.js";

const GW = process.env.ETHERNA_GATEWAY_URL || "https://gateway.etherna.io";
const DEPTH = 19, TTL_DAYS = 30, MARGIN_PCT = 10, MAX_BZZ = 2.5;

async function main() {
  await ensureEthernaToken();
  const tok = getCachedEthernaToken()!;

  const est = await estimateEthernaBatch({ depth: DEPTH, ttlDays: TTL_DAYS, marginPct: MARGIN_PCT });
  console.log(`pre-spend: depth ${DEPTH}, ttl ${TTL_DAYS}d, margin ${MARGIN_PCT}% → ${est.estimatedBZZ} BZZ (≈ $${(Number(est.estimatedBZZ) * 0.0505).toFixed(4)})`);
  console.log("provisioning (waits for usable, up to ~3 min)...");

  const res = await provisionEthernaBatch({
    depth: DEPTH, ttlDays: TTL_DAYS, marginPct: MARGIN_PCT, maxBZZ: MAX_BZZ, label: "woco-platform-30d",
  });
  console.log(`purchased: ${res.batchId}  | USDC debit $${res.debitXDai}`);

  const b = await (await fetch(`${GW}/stamps/${res.batchId}`, { headers: { Authorization: `Bearer ${tok}` } })).json() as Record<string, unknown>;
  const ttlDaysActual = Number(b.batchTTL ?? 0) / 86400;
  console.log(`readback: depth=${b.depth} usable=${b.usable} ttl=${ttlDaysActual.toFixed(2)}d utilization=${b.utilization}`);

  if (Number(b.depth) !== DEPTH || b.usable !== true || ttlDaysActual < TTL_DAYS) {
    console.error("⚠ READBACK MISMATCH — review before wiring in.");
    process.exit(2);
  }
  console.log(`\n✅ ETHERNA_PLATFORM_BATCH=${res.batchId}`);
}
main().catch((e) => { console.error("FATAL:", e?.message ?? e); process.exit(1); });
