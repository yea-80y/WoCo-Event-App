import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { RECOVERY_STATUS_VERSION } from "@woco/shared";
import {
  getRecoveryEnvelope,
  getRecoveryStatus,
  putRecoveryStatus,
  getRecoveryByGuardian,
  putRecoveryByGuardian,
} from "../lib/recovery/service.js";

export const recovery = new Hono<AppEnv>();

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
// Sub-ENS label charset (a single DNS-ish label, no dot/suffix): bounds what we
// persist as the human-readable display hint.
const LABEL_RE = /^[a-z0-9-]{1,63}$/;

// POST /api/recovery/escrow — authenticated. §13: the sealed escrow itself is now a
// GUARDIAN-owned SOC the client signs + uploads directly (`/api/swarm/soc`); this
// endpoint no longer stores the envelope. It records only the untrusted PLATFORM
// HINTS — a presence flag (kernel→guardian) and the guardian→kernel reverse index —
// used to render the setup screen and auto-find an account at recovery time.
// The kernelAddress is taken from the verified session parent, never the body.
recovery.post("/escrow", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const body = (c.get("body") ?? {}) as { guardianAddress?: unknown; label?: unknown };

  if (typeof body.guardianAddress !== "string" || !ADDR_RE.test(body.guardianAddress)) {
    return c.json({ ok: false, error: "Invalid guardianAddress" }, 400);
  }
  const guardianAddress = body.guardianAddress.toLowerCase();
  const label =
    typeof body.label === "string" && LABEL_RE.test(body.label.toLowerCase())
      ? body.label.toLowerCase()
      : undefined;

  try {
    // Presence hint keyed by the caller's own Kernel — drives the "backup on record"
    // UI. Holds no escrow/key; a user can only write their own (parent-stamped) doc.
    await putRecoveryStatus(parentAddress, {
      v: RECOVERY_STATUS_VERSION,
      configured: true,
      guardianAddress,
      label,
      updatedAt: Date.now(),
    });

    // Best-effort reverse-lookup so the backup wallet can auto-find this account.
    // NON-FATAL and unverified: a poisoned hit is harmless because recovery reads +
    // decrypts the guardian-owned SOC (sealed to the real guardian key) before any
    // on-chain action (see RecoveryGuardianIndex SECURITY).
    try {
      await putRecoveryByGuardian(guardianAddress, { kernelAddress: parentAddress, label });
    } catch (err) {
      console.error("[api] putRecoveryByGuardian (non-fatal):", err);
    }

    return c.json({ ok: true, data: { kernelAddress: parentAddress } });
  } catch (err) {
    console.error("[api] putRecoveryStatus error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: `Failed to record recovery hint: ${msg}` }, 500);
  }
});

// GET /api/recovery/status/:kernelAddress — PUBLIC presence hint (§13). Returns the
// kernel→guardian status doc, or a synthesised {configured:true} for LEGACY accounts
// whose envelope still sits on the old platform feed. Untrusted convenience: real
// recoverability is proven only by decrypting the guardian SOC.
recovery.get("/status/:kernelAddress", async (c) => {
  const kernelAddress = c.req.param("kernelAddress");
  if (!ADDR_RE.test(kernelAddress)) {
    return c.json({ ok: false, error: "Invalid kernelAddress" }, 400);
  }
  try {
    let status = await getRecoveryStatus(kernelAddress);
    if (!status) {
      const legacy = await getRecoveryEnvelope(kernelAddress);
      if (legacy) status = { v: RECOVERY_STATUS_VERSION, configured: true };
    }
    return c.json({ ok: true, data: status });
  } catch (err) {
    console.error("[api] getRecoveryStatus error:", err);
    return c.json({ ok: false, error: "Failed to load recovery status" }, 500);
  }
});

// GET /api/recovery/by-guardian/:guardianAddress — PUBLIC. Returns the account a
// guardian protects (RecoveryGuardianIndex), so a connected backup wallet can
// auto-find it. Convenience hint only; the escrow decrypt is the real guard.
recovery.get("/by-guardian/:guardianAddress", async (c) => {
  const guardianAddress = c.req.param("guardianAddress");
  if (!ADDR_RE.test(guardianAddress)) {
    return c.json({ ok: false, error: "Invalid guardianAddress" }, 400);
  }
  try {
    const index = await getRecoveryByGuardian(guardianAddress);
    return c.json({ ok: true, data: index });
  } catch (err) {
    console.error("[api] getRecoveryByGuardian error:", err);
    return c.json({ ok: false, error: "Failed to load recovery index" }, 500);
  }
});

// GET /api/recovery/escrow/:kernelAddress — PUBLIC, LEGACY (§13). New escrows live
// in a guardian-owned SOC read directly by the client; this returns the old
// platform-signed envelope and exists ONLY as the recovery read-fallback for
// accounts protected before the migration. Ciphertext to the guardian, so public
// read is safe by design (§11.6).
recovery.get("/escrow/:kernelAddress", async (c) => {
  const kernelAddress = c.req.param("kernelAddress");
  if (!ADDR_RE.test(kernelAddress)) {
    return c.json({ ok: false, error: "Invalid kernelAddress" }, 400);
  }
  try {
    const envelope = await getRecoveryEnvelope(kernelAddress);
    return c.json({ ok: true, data: envelope });
  } catch (err) {
    console.error("[api] getRecoveryEnvelope error:", err);
    return c.json({ ok: false, error: "Failed to load recovery envelope" }, 500);
  }
});
