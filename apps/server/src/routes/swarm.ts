import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { uploadSignedSoc, readSocPayload, type SignedSocInput } from "../lib/swarm/soc-upload.js";

/**
 * Generic client-signed Single-Owner-Chunk write rail (Phase A of
 * CLIENT_FEED_SIGNER_HANDOVER.md). The client signs a SOC with a key it owns; the
 * server stamps + uploads it with the platform postage batch. See soc-upload.ts
 * for the validation + authorization rationale.
 */
export const swarmRoutes = new Hono<AppEnv>();

/**
 * POST /api/swarm/soc — stamp + upload a client-signed SOC.
 * Auth-gated. Any authenticated user may stamp their OWN validly-signed SOC; the
 * server verifies the signature recovers to the claimed owner before stamping.
 */
swarmRoutes.post("/soc", requireAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const b = body as Partial<SignedSocInput>;
  if (
    typeof b.owner !== "string" ||
    typeof b.identifier !== "string" ||
    typeof b.signature !== "string" ||
    typeof b.span !== "string" ||
    typeof b.payload !== "string"
  ) {
    return c.json({ ok: false, error: "Missing SOC fields" }, 400);
  }

  try {
    const ref = await uploadSignedSoc({
      owner: b.owner,
      identifier: b.identifier,
      signature: b.signature,
      span: b.span,
      payload: b.payload,
    });
    return c.json({ ok: true, data: ref });
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 400) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
    console.error("[swarm] SOC upload failed:", err);
    return c.json({ ok: false, error: "SOC upload failed" }, 502);
  }
});

/**
 * GET /api/swarm/soc/:owner/:identifier — read a SOC's inline payload by computed
 * chunk address. UNAUTHENTICATED: SOCs are public on Swarm, and the recovery
 * envelope payload is HPKE-sealed. Reads happen during new-device login BEFORE a
 * session exists, so this must be open. Returns the payload base64-encoded.
 */
swarmRoutes.get("/soc/:owner/:identifier", async (c) => {
  const owner = c.req.param("owner");
  const identifier = c.req.param("identifier");
  try {
    const payload = await readSocPayload(owner, identifier);
    if (!payload) return c.json({ ok: false, error: "Not found" }, 404);
    return c.json({ ok: true, data: { payloadB64: Buffer.from(payload).toString("base64") } });
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 400) return c.json({ ok: false, error: (err as Error).message }, 400);
    console.error("[swarm] SOC read failed:", err);
    return c.json({ ok: false, error: "SOC read failed" }, 502);
  }
});
