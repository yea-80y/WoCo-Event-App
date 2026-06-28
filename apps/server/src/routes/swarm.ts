import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { uploadSignedSoc, readSocPayload, type SignedSocInput } from "../lib/swarm/soc-upload.js";
import { uploadToBytes } from "../lib/swarm/bytes.js";
import { batchForDeploy } from "../lib/etherna/batch-router.js";

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
 * POST /api/swarm/bytes — stamp + upload client-supplied content to Swarm /bytes.
 *
 * Trust-minimised by construction: the content is CONTENT-ADDRESSED, so the
 * returned ref IS the keccak of the bytes — the server cannot substitute different
 * content without changing the ref, and the organiser commits that ref inside a
 * carrier-signed editions SOC. The server is therefore a pure postage relay (it
 * lends the batch, can't forge). This is the missing transport primitive for
 * client-owned editions bodies (woco.ticket.v1 + the page-0 meta blob); it routes
 * to the SAME batch the event content used — Etherna when the builder picked the
 * Etherna gateway (the builder IS the event creator), WoCo otherwise.
 *
 * Auth-gated; abuse is bounded by auth + postage cost (same model as /soc). The
 * payload is capped well above a ticket body so a bug can't stamp megabytes.
 */
const MAX_STAMP_BYTES = 64 * 1024;

swarmRoutes.post("/bytes", requireAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const b = body as { dataB64?: unknown; gatewayUrl?: unknown };
  if (typeof b.dataB64 !== "string" || b.dataB64.length === 0) {
    return c.json({ ok: false, error: "Missing dataB64" }, 400);
  }
  if (b.gatewayUrl !== undefined && typeof b.gatewayUrl !== "string") {
    return c.json({ ok: false, error: "Invalid gatewayUrl" }, 400);
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(b.dataB64, "base64");
  } catch {
    return c.json({ ok: false, error: "Invalid base64" }, 400);
  }
  if (bytes.length < 1 || bytes.length > MAX_STAMP_BYTES) {
    return c.json({ ok: false, error: `Payload must be 1..${MAX_STAMP_BYTES} bytes` }, 400);
  }

  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  try {
    // Route to the event's batch — Etherna when the builder picked it (events
    // never trigger a batch purchase; falls back to the platform Etherna batch).
    const selection = batchForDeploy({
      ownerAddress: parentAddress,
      gatewayUrl: typeof b.gatewayUrl === "string" ? b.gatewayUrl : "",
      deployType: "event",
    });
    const ref = await uploadToBytes(new Uint8Array(bytes), selection);
    return c.json({ ok: true, data: { ref } });
  } catch (err) {
    console.error("[swarm] bytes stamp failed:", err);
    return c.json({ ok: false, error: "Bytes upload failed" }, 502);
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
