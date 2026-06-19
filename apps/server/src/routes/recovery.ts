import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import type { RecoveryEnvelope } from "@woco/shared";
import { RECOVERY_ENVELOPE_VERSION } from "@woco/shared";
import {
  getRecoveryEnvelope,
  putRecoveryEnvelope,
  getRecoveryByGuardian,
  putRecoveryByGuardian,
} from "../lib/recovery/service.js";

export const recovery = new Hono<AppEnv>();

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const HEX_RE = /^[0-9a-f]+$/;
// Sub-ENS label charset (a single DNS-ish label, no dot/suffix): bounds what we
// persist as the human-readable display hint in the guardian index.
const LABEL_RE = /^[a-z0-9-]{1,63}$/;
// Generous bounds so a v1 (1-of-1) or small M-of-N envelope fits the 4096-byte
// feed page while rejecting anything that is obviously not our envelope.
const MAX_GUARDIANS = 10;
const MAX_HEX_FIELD = 4096; // hex chars

function isHex(s: unknown, max = MAX_HEX_FIELD): s is string {
  return typeof s === "string" && s.length > 0 && s.length <= max && s.length % 2 === 0 && HEX_RE.test(s);
}

/** Validate the sealed envelope shape. Confidentiality rests on the crypto, not
 *  this check — but we refuse to persist malformed/oversized blobs under a
 *  user's recovery topic. */
function parseEnvelope(body: unknown): RecoveryEnvelope | { error: string } {
  if (!body || typeof body !== "object") return { error: "Missing envelope" };
  const e = (body as { envelope?: unknown }).envelope ?? body;
  const env = e as Partial<RecoveryEnvelope>;
  if (env.v !== RECOVERY_ENVELOPE_VERSION) return { error: "Unsupported envelope version" };
  if (typeof env.kernelAddress !== "string" || !ADDR_RE.test(env.kernelAddress)) {
    return { error: "Invalid kernelAddress" };
  }
  if (!isHex(env.nonce, 64)) return { error: "Invalid nonce" };
  if (!isHex(env.ciphertext)) return { error: "Invalid ciphertext" };
  if (
    !Array.isArray(env.wrappedDeks) ||
    env.wrappedDeks.length === 0 ||
    env.wrappedDeks.length > MAX_GUARDIANS ||
    !env.wrappedDeks.every((w) => isHex(w))
  ) {
    return { error: "Invalid wrappedDeks" };
  }
  return {
    v: env.v,
    kernelAddress: env.kernelAddress.toLowerCase(),
    nonce: env.nonce,
    ciphertext: env.ciphertext,
    wrappedDeks: env.wrappedDeks,
  };
}

// POST /api/recovery/escrow — authenticated. Stores the sealed envelope under
// the CALLER'S OWN Kernel topic. The kernelAddress is taken from the verified
// session parent, never trusted from the body: a user can only write their own
// recovery blob, so no one can overwrite a victim's envelope to hijack recovery.
recovery.post("/escrow", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const parsed = parseEnvelope(c.get("body"));
  if ("error" in parsed) return c.json({ ok: false, error: parsed.error }, 400);

  // The envelope is AEAD-bound to its kernelAddress; require it to match the
  // authenticated account so the stored blob and the topic agree.
  if (parsed.kernelAddress !== parentAddress) {
    return c.json({ ok: false, error: "Envelope kernelAddress does not match the authenticated account" }, 403);
  }

  try {
    await putRecoveryEnvelope(parentAddress, parsed);

    // Best-effort reverse-lookup hint so the user's backup wallet can auto-find
    // this account at recovery time. NON-FATAL: the escrow above is the truth;
    // the index is an untrusted convenience (see RecoveryGuardianIndex SECURITY).
    // We DON'T verify guardianAddress against the kernel here — a poisoned hit is
    // harmless because recovery decrypts the envelope (sealed to the real
    // guardian key) before any on-chain action.
    const body = (c.get("body") ?? {}) as { guardianAddress?: unknown; label?: unknown };
    if (typeof body.guardianAddress === "string" && ADDR_RE.test(body.guardianAddress)) {
      const label =
        typeof body.label === "string" && LABEL_RE.test(body.label.toLowerCase())
          ? body.label.toLowerCase()
          : undefined;
      try {
        await putRecoveryByGuardian(body.guardianAddress, { kernelAddress: parentAddress, label });
      } catch (err) {
        console.error("[api] putRecoveryByGuardian (non-fatal):", err);
      }
    }

    return c.json({ ok: true, data: { kernelAddress: parentAddress } });
  } catch (err) {
    console.error("[api] putRecoveryEnvelope error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: `Failed to store recovery envelope: ${msg}` }, 500);
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

// GET /api/recovery/escrow/:kernelAddress — PUBLIC. The locked-out user has lost
// their signer and cannot authenticate; the envelope is ciphertext encrypted to
// the guardian, so public read is safe by design (§11.6).
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
