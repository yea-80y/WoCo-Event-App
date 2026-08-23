import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { uploadSignedSoc, type SignedSocInput } from "../lib/swarm/soc-upload.js";
import { readVerifiedSoc } from "../lib/swarm/soc-read.js";
import { SlidingWindowLimiter } from "../lib/http/rate-limit.js";
import { uploadToBytes } from "../lib/swarm/bytes.js";
import { batchForDeploy } from "../lib/etherna/batch-router.js";
import { clientIp } from "../lib/http/client-ip.js";
import { jsonBodyLimit } from "../lib/http/body-limit.js";
import {
  socRelayGate,
  bytesRelayGate,
  classifyRelayPayload,
  SOC_RELAY_MAX_BODY_BYTES,
  BYTES_RELAY_MAX_BODY_BYTES,
} from "../lib/swarm/soc-relay-limits.js";

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
 *
 * Rate-limited per parent / per IP / globally, with a tighter bucket for
 * statement-shaped payloads (#301) — see soc-relay-limits.ts. The body cap is
 * the largest honest request (4096-byte payload as hex, signature, identifier,
 * owner, span, a gateway URL) with room to spare; it sits BEFORE requireAuth so
 * the auth middleware never reads and hashes megabytes.
 */
swarmRoutes.post("/soc", jsonBodyLimit(SOC_RELAY_MAX_BODY_BYTES), requireAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const b = body as Partial<SignedSocInput> & { gatewayUrl?: unknown };
  if (
    typeof b.owner !== "string" ||
    typeof b.identifier !== "string" ||
    typeof b.signature !== "string" ||
    typeof b.span !== "string" ||
    typeof b.payload !== "string"
  ) {
    return c.json({ ok: false, error: "Missing SOC fields" }, 400);
  }
  if (b.gatewayUrl !== undefined && typeof b.gatewayUrl !== "string") {
    return c.json({ ok: false, error: "Invalid gatewayUrl" }, 400);
  }

  // After the shape check (so a malformed flood is a 400, not a charge) and
  // BEFORE the signature verify + whitelist + upload, which is the cost.
  const gate = socRelayGate.decide({
    parent: (c.get("parentAddress") as string).toLowerCase(),
    ip: clientIp(c),
    kind: classifyRelayPayload(b.payload),
  });
  if (!gate.allowed) return c.json({ ok: false, error: gate.reason }, gate.status);

  try {
    // Same routing as /bytes: Etherna user batch when the builder picked the
    // Etherna gateway (platform Etherna batch fallback), WoCo platform otherwise.
    const selection = batchForDeploy({
      ownerAddress: (c.get("parentAddress") as string).toLowerCase(),
      gatewayUrl: typeof b.gatewayUrl === "string" ? b.gatewayUrl : "",
      deployType: "event",
    });
    const ref = await uploadSignedSoc({
      owner: b.owner,
      identifier: b.identifier,
      signature: b.signature,
      span: b.span,
      payload: b.payload,
    }, selection);
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

swarmRoutes.post("/bytes", jsonBodyLimit(BYTES_RELAY_MAX_BODY_BYTES), requireAuth, async (c) => {
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
  // Up to 16 chunks per call, so its own (tighter) gate (#301).
  const gate = bytesRelayGate.decide({ parent: parentAddress, ip: clientIp(c), kind: "other" });
  if (!gate.allowed) return c.json({ ok: false, error: gate.reason }, gate.status);
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

// The public read is a bee network search (and, for Etherna-stamped feeds, an
// Etherna read) per call. Per IP; sized for the write-path version probes a
// single publish makes (a few dozen) with headroom for a venue NAT.
const SOC_READ_IP = new SlidingWindowLimiter([{ limit: 600, windowMs: 60_000 }]);

/**
 * GET /api/swarm/soc/:owner/:identifier[?gatewayUrl=…] — the client's server
 * FALLBACK read (#156). UNAUTHENTICATED: SOCs are public on Swarm, and reads
 * happen during new-device login BEFORE a session exists.
 *
 * Returns the WHOLE SOC (owner, identifier, signature, span, payload) so the
 * client re-verifies it — this origin is a transport, never a trust root. The
 * server verifies too, and a source that answers with bytes that are not this
 * chunk is treated as unreachable, not as "absent". Three answers:
 *   200 { …soc }                       — verified found
 *   404 { code: "absent" }             — every verdict source ran its search and found nothing
 *   503 { code: "unavailable", error } — somebody could not be asked; NOT a verdict
 * `gatewayUrl` is the writer's own routing signal, forwarded by the write-path
 * probe: an Etherna-stamped feed's head may still sit only in Etherna's store
 * for a few seconds, so that read must ask Etherna too, and must say
 * `unavailable` (not 404) if Etherna cannot be asked.
 */
swarmRoutes.get("/soc/:owner/:identifier", async (c) => {
  const owner = c.req.param("owner");
  const identifier = c.req.param("identifier");
  if (!SOC_READ_IP.allow(`ip:${clientIp(c)}`)) return c.json({ ok: false, error: "Rate limited" }, 429);
  const gatewayUrl = c.req.query("gatewayUrl");
  try {
    const res = await readVerifiedSoc(owner, identifier, {
      gatewayUrl: typeof gatewayUrl === "string" && gatewayUrl.length <= 512 ? gatewayUrl : undefined,
    });
    if (res.status === "absent") return c.json({ ok: false, error: "Not found", code: "absent" }, 404);
    if (res.status === "unavailable") {
      return c.json({ ok: false, error: `SOC read unavailable: ${res.reason}`, code: "unavailable" }, 503);
    }
    const { soc } = res;
    return c.json({
      ok: true,
      data: {
        owner: soc.owner,
        identifier: soc.identifier,
        signature: soc.signature,
        span: soc.span,
        payloadB64: Buffer.from(soc.payload).toString("base64"),
        source: soc.source,
      },
    });
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 400) return c.json({ ok: false, error: (err as Error).message }, 400);
    console.error("[swarm] SOC read failed:", err);
    return c.json({ ok: false, error: "SOC read failed", code: "unavailable" }, 503);
  }
});
