import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { RECOVERY_STATUS_VERSION } from "@woco/shared";
import {
  getRecoveryEnvelope,
  getRecoveryStatus,
  putRecoveryStatus,
  getRecoveryByGuardian,
  getRecoveryByGuardianRaw,
  putRecoveryByGuardian,
} from "../lib/recovery/service.js";
import { MAX_CLEAR_GUARDIANS, mayTombstone, planHintClear } from "../lib/recovery/tombstone.js";

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

// POST /api/recovery/escrow/clear — authenticated. The mirror of /escrow, run after
// the account proved on-chain that it uninstalled its recovery route (#165). Marks
// the presence hint not-configured and tombstones the guardian reverse-index entries
// so a removed backup no longer auto-finds this account in the portal.
//
// AUTHZ: an index entry is only tombstoned when it already points AT the caller's own
// Kernel, so naming someone else's guardian address does nothing. The hints carry no
// authority either way — the chain does (see RecoveryGuardianIndex SECURITY).
//
// It clears HINTS ONLY. The revoke itself is the client's sudo userOp; a server that
// could turn recovery off by itself would be a new attack surface.
recovery.post("/escrow/clear", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const body = (c.get("body") ?? {}) as { guardianAddresses?: unknown; keepStatus?: unknown };
  // `keepStatus: true` = the client revoked ONE guardian on-chain and the account
  // still has working backups (#164): tombstone only the named entries and leave the
  // presence hint standing. Anything but literal `true` is the remove-all shape.
  const keepStatus = body.keepStatus === true;

  const requested = Array.isArray(body.guardianAddresses) ? body.guardianAddresses : [];
  // Bound BEFORE validating or de-duplicating: no request should get the server to
  // walk a multi-megabyte array at all. Reject rather than truncate, so a caller
  // with more guardians than this learns instead of silently losing some.
  if (requested.length > MAX_CLEAR_GUARDIANS) {
    return c.json({ ok: false, error: `Too many guardianAddresses (max ${MAX_CLEAR_GUARDIANS})` }, 400);
  }
  if (requested.some((g) => typeof g !== "string" || !ADDR_RE.test(g))) {
    return c.json({ ok: false, error: "Invalid guardianAddresses" }, 400);
  }

  try {
    // The status doc names the most recent guardian; the client supplies the rest
    // from its own manifest, which is the only record of guardians replaced earlier.
    const existing = await getRecoveryStatus(parentAddress);
    const { flipStatus, targets } = planHintClear({
      requested: requested as string[],
      statusGuardian: existing?.guardianAddress,
      keepStatus,
    });

    if (flipStatus) {
      await putRecoveryStatus(parentAddress, {
        v: RECOVERY_STATUS_VERSION,
        configured: false,
        updatedAt: Date.now(),
      });
    }

    // Best-effort, exactly like the register path — but REPORTED, not swallowed.
    //
    // Do NOT reason that "#162's on-chain pre-flight rejects a stale hint anyway":
    // that pre-flight reads the caller hook's `allowed` mapping, which is APPEND-ONLY
    // and still returns true for a removed guardian. What actually neutralises a
    // stale hint is the portal's own recovery-route read returning "absent". Saying
    // it wrong here would invite someone to weaken that read later.
    let cleared = 0;
    let failed = 0;
    for (const guardianAddress of targets) {
      try {
        const index = await getRecoveryByGuardianRaw(guardianAddress);
        if (!mayTombstone(index, parentAddress)) continue;
        await putRecoveryByGuardian(guardianAddress, { ...index!, revoked: true });
        cleared++;
      } catch (err) {
        failed++;
        console.error("[api] tombstone putRecoveryByGuardian (non-fatal):", err);
      }
    }

    return c.json({
      ok: true,
      data: { kernelAddress: parentAddress, clearedGuardians: cleared, failedGuardians: failed },
    });
  } catch (err) {
    console.error("[api] clear recovery hint error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: `Failed to clear recovery hint: ${msg}` }, 500);
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
