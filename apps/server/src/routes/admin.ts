import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import {
  getBee,
  getPlatformOwner,
  FEED_PRIVATE_KEY,
  POSTAGE_BATCH_ID,
  BEE_URL,
} from "../config/swarm.js";

const admin = new Hono<AppEnv>();

export interface SetupCheckResult {
  apiOk: true;
  signerConfigured: boolean;
  signerAddress: string | null;
  signerError: string | null;
  batchConfigured: boolean;
  batchUsable: boolean;
  batchTTL: number | null;        // seconds until expiry
  batchUtilization: number | null;
  beeConnected: boolean;
  beeVersion: string | null;
  beePeers: number | null;
  beeError: string | null;
}

/**
 * GET /api/admin/setup-check
 *
 * Unauthenticated setup health check for the site-builder wizard.
 * Reports on: feed signer, postage batch (TTL + utilization), and Bee node
 * connectivity (version + peer count).
 *
 * Does NOT expose private keys — only the derived owner address.
 */
admin.get("/setup-check", async (c) => {
  const result: SetupCheckResult = {
    apiOk: true,
    signerConfigured: false,
    signerAddress: null,
    signerError: null,
    batchConfigured: !!POSTAGE_BATCH_ID,
    batchUsable: false,
    batchTTL: null,
    batchUtilization: null,
    beeConnected: false,
    beeVersion: null,
    beePeers: null,
    beeError: null,
  };

  // ── Feed signer ─────────────────────────────────────────────────────────────
  if (FEED_PRIVATE_KEY) {
    try {
      const owner = getPlatformOwner();
      result.signerConfigured = true;
      result.signerAddress = owner.toHex();
    } catch (e) {
      result.signerError = e instanceof Error ? e.message : "Invalid key";
    }
  }

  // ── Bee connectivity ─────────────────────────────────────────────────────────
  try {
    const healthResp = await fetch(`${BEE_URL}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (healthResp.ok) {
      const health = (await healthResp.json()) as Record<string, unknown>;
      result.beeConnected = true;
      result.beeVersion = (health.version as string) ?? null;
    } else {
      result.beeError = `Bee /health returned ${healthResp.status}`;
    }
  } catch (e) {
    result.beeError = e instanceof Error ? e.message : "Connection refused";
  }

  // ── Bee peer count ───────────────────────────────────────────────────────────
  if (result.beeConnected) {
    try {
      const peersResp = await fetch(`${BEE_URL}/peers`, {
        signal: AbortSignal.timeout(5000),
      });
      if (peersResp.ok) {
        const peers = (await peersResp.json()) as { peers?: unknown[] };
        result.beePeers = Array.isArray(peers.peers) ? peers.peers.length : 0;
      }
    } catch {
      // non-fatal — peer count stays null
    }
  }

  // ── Postage batch ─────────────────────────────────────────────────────────────
  // Note: the stamps admin API is only available on Bee's internal API port.
  // If BEE_URL points to a public gateway, this will 404 — treat that as
  // "not available" rather than an error (the gateway still works for uploads).
  if (POSTAGE_BATCH_ID && result.beeConnected) {
    try {
      const batchResp = await fetch(`${BEE_URL}/stamps/${POSTAGE_BATCH_ID}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (batchResp.ok) {
        const contentType = batchResp.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          const batch = (await batchResp.json()) as Record<string, unknown>;
          result.batchUsable = (batch.usable as boolean) ?? false;
          result.batchTTL = typeof batch.batchTTL === "number" ? batch.batchTTL : null;
          result.batchUtilization = typeof batch.utilization === "number" ? batch.utilization : null;
        }
        // non-JSON response on 200 — treat as not available
      }
      // 404 / non-2xx: stamps API not exposed on this endpoint — not an error
    } catch {
      // non-fatal — batch info stays null
    }
  }

  return c.json({ ok: true, data: result });
});

export { admin };
