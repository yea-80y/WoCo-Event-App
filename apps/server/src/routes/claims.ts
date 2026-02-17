import { Hono } from "hono";
import type { Hex0x, SealedBox } from "@woco/shared";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { claimTicket, hashEmail, getClaimStatus, type ClaimIdentifier } from "../lib/event/claim-service.js";

const claims = new Hono<AppEnv>();

/** In-memory rate limiter for email claims: IP → timestamps */
const emailClaimRateMap = new Map<string, number[]>();
const EMAIL_CLAIM_RATE_LIMIT = 10; // max claims
const EMAIL_CLAIM_RATE_WINDOW = 300_000; // per 5 minutes

function checkEmailRateLimit(ip: string): boolean {
  const now = Date.now();
  const timestamps = emailClaimRateMap.get(ip) ?? [];
  const recent = timestamps.filter((t) => now - t < EMAIL_CLAIM_RATE_WINDOW);
  if (recent.length >= EMAIL_CLAIM_RATE_LIMIT) return false;
  recent.push(now);
  emailClaimRateMap.set(ip, recent);
  return true;
}

// POST /api/events/:eventId/series/:seriesId/claim
// Wallet claims: authenticated (session delegation proves address ownership)
// Email claims: unauthenticated but rate-limited by IP
claims.post("/:eventId/series/:seriesId/claim", async (c) => {
  const seriesId = c.req.param("seriesId");

  // Peek at mode to decide auth path
  let rawBody: Record<string, unknown>;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const mode = (rawBody.mode as string) || "wallet";

  let identifier: ClaimIdentifier;

  if (mode === "wallet") {
    // Wallet claims require session delegation — proves the caller controls the address
    const sessionAddress = (rawBody.session as string) ??
      c.req.header("x-session-address");
    if (!sessionAddress) {
      return c.json({ ok: false, error: "Wallet claims require session delegation" }, 401);
    }

    const { extractDelegation, verifyDelegation } = await import("../lib/auth/verify-delegation.js");
    const delegation = extractDelegation(c.req.raw, rawBody as any);
    if (!delegation) {
      return c.json({ ok: false, error: "Missing session delegation" }, 401);
    }

    const allowedHosts = process.env.ALLOWED_HOSTS?.split(",") ?? undefined;
    const result = verifyDelegation(delegation, sessionAddress, allowedHosts);
    if (!result.valid) {
      return c.json({ ok: false, error: result.error }, 403);
    }

    // Use the verified parent address — NOT the address from the request body
    identifier = { type: "wallet", address: result.parentAddress!.toLowerCase() as Hex0x };

  } else if (mode === "email") {
    const email = rawBody.email as string;
    if (!email || !email.includes("@")) {
      return c.json({ ok: false, error: "Invalid email" }, 400);
    }

    // Rate limit email claims by IP
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
      || c.req.header("cf-connecting-ip")
      || "unknown";
    if (!checkEmailRateLimit(ip)) {
      return c.json({ ok: false, error: "Too many claims. Please try again later." }, 429);
    }

    identifier = { type: "email", email, emailHash: hashEmail(email) };

  } else if (mode === "api") {
    const apiKey = rawBody.apiKey as string;
    const expected = process.env.ORGANIZER_API_KEY;
    if (!expected || apiKey !== expected) {
      return c.json({ ok: false, error: "Invalid API key" }, 403);
    }
    // API mode uses wallet address or email passed by organizer
    const address = rawBody.walletAddress as string;
    const email = rawBody.email as string;
    if (address) {
      identifier = { type: "wallet", address: address.toLowerCase() as Hex0x };
    } else if (email) {
      identifier = { type: "email", email, emailHash: hashEmail(email) };
    } else {
      return c.json({ ok: false, error: "API mode requires walletAddress or email" }, 400);
    }

  } else {
    return c.json({ ok: false, error: `Unknown claim mode: ${mode}` }, 400);
  }

  try {
    // Pass encrypted order data through (opaque to server — only organizer can decrypt)
    const encryptedOrder = rawBody.encryptedOrder as SealedBox | undefined;
    const ticket = await claimTicket({ seriesId, identifier, encryptedOrder });
    return c.json({ ok: true, ticket, edition: ticket.edition });
  } catch (err) {
    console.error("[api] claimTicket error:", err);
    const message = err instanceof Error ? err.message : "Failed to claim ticket";
    return c.json({ ok: false, error: message }, 500);
  }
});

// GET /api/events/:eventId/series/:seriesId/claim-status - check availability
claims.get("/:eventId/series/:seriesId/claim-status", async (c) => {
  const seriesId = c.req.param("seriesId");
  const userAddress = c.req.query("address");

  try {
    const status = await getClaimStatus(seriesId, userAddress || undefined);
    return c.json({ ok: true, data: status });
  } catch (err) {
    console.error("[api] getClaimStatus error:", err);
    const message = err instanceof Error ? err.message : "Failed to get claim status";
    return c.json({ ok: false, error: message }, 500);
  }
});

export { claims };
