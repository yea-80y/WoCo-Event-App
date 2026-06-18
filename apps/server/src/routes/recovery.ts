import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import type { RecoveryEnvelope } from "@woco/shared";
import { RECOVERY_ENVELOPE_VERSION } from "@woco/shared";
import { getRecoveryEnvelope, putRecoveryEnvelope } from "../lib/recovery/service.js";

export const recovery = new Hono<AppEnv>();

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const HEX_RE = /^[0-9a-f]+$/;
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
    return c.json({ ok: true, data: { kernelAddress: parentAddress } });
  } catch (err) {
    console.error("[api] putRecoveryEnvelope error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: `Failed to store recovery envelope: ${msg}` }, 500);
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
