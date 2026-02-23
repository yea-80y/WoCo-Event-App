import { Hono } from "hono";
import { verifyMessage } from "ethers";
import type { Hex0x, SealedBox } from "@woco/shared";
import { PASSKEY_CLAIM_MAX_AGE_MS, PASSKEY_CLAIM_PREFIX } from "@woco/shared";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { claimTicket, hashEmail, getClaimStatus, type ClaimIdentifier } from "../lib/event/claim-service.js";

const claims = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Double-spend prevention
// ---------------------------------------------------------------------------

// Option 1: In-flight lock — fast-rejects a duplicate request from the same
// identifier while an identical claim is already being processed.
// Key format: "{seriesId}:{address|emailHash}"
const claimInFlight = new Set<string>();

// Option 2: Per-series async queue — serialises ALL claim operations for a
// given series so each one reads the latest Swarm feed state before writing.
// Swarm has no atomic compare-and-swap; without this two concurrent requests
// from *different* users can read the same unclaimed slot and both succeed.
const seriesQueues = new Map<string, Promise<void>>();

function queueSeriesClaim<T>(seriesId: string, fn: () => Promise<T>): Promise<T> {
  const prev = (seriesQueues.get(seriesId) ?? Promise.resolve()) as Promise<void>;
  const current = prev.then(() => fn());
  // Store an error-swallowing tail so the chain never permanently breaks
  seriesQueues.set(seriesId, current.then(() => {}, () => {}));
  return current;
}

// ---------------------------------------------------------------------------
// Email rate limiter
// ---------------------------------------------------------------------------

/** In-memory rate limiter for email claims: IP → timestamps */
const emailClaimRateMap = new Map<string, number[]>();
const EMAIL_CLAIM_RATE_LIMIT = 3; // max claims
const EMAIL_CLAIM_RATE_WINDOW = 900_000; // per 15 minutes

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

  } else if (mode === "passkey" || mode === "wallet-signed") {
    // Both passkey and wallet-signed use EIP-191 personal_sign — same server-side verification
    const address = rawBody.address as string;
    const signature = rawBody.signature as string;
    const timestamp = rawBody.timestamp as number;

    if (!address || !signature || !timestamp) {
      return c.json({ ok: false, error: "Signed claims require address, signature, and timestamp" }, 400);
    }

    // Reject stale signatures
    if (Date.now() - timestamp > PASSKEY_CLAIM_MAX_AGE_MS) {
      return c.json({ ok: false, error: "Claim signature expired" }, 400);
    }

    // Reconstruct and verify the signed message
    const eventId = c.req.param("eventId");
    const message = PASSKEY_CLAIM_PREFIX + eventId + ":" + seriesId + ":" + timestamp;

    let recoveredAddress: string;
    try {
      recoveredAddress = verifyMessage(message, signature);
    } catch {
      return c.json({ ok: false, error: "Invalid signature" }, 403);
    }

    if (recoveredAddress.toLowerCase() !== address.toLowerCase()) {
      return c.json({ ok: false, error: "Signature does not match claimed address" }, 403);
    }

    identifier = { type: "wallet", address: recoveredAddress.toLowerCase() as Hex0x };

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

  const encryptedOrder = rawBody.encryptedOrder as SealedBox | undefined;

  // Build dedup key from the verified identifier
  const identifierKey = identifier.type === "wallet"
    ? identifier.address.toLowerCase()
    : identifier.emailHash;
  const lockKey = `${seriesId}:${identifierKey}`;

  // Option 1: fast-reject if the exact same identifier is already mid-claim
  if (claimInFlight.has(lockKey)) {
    return c.json({ ok: false, error: "Claim already in progress — please wait" }, 429);
  }
  claimInFlight.add(lockKey);

  try {
    // Option 2: serialise all claims for this series through a queue
    const ticket = await queueSeriesClaim(seriesId, () =>
      claimTicket({ seriesId, identifier, encryptedOrder }),
    );
    return c.json({ ok: true, ticket, edition: ticket.edition });
  } catch (err) {
    console.error("[api] claimTicket error:", err);
    const message = err instanceof Error ? err.message : "Failed to claim ticket";
    // 409 Conflict for business-rule rejections (already claimed, sold out)
    const status = (message === "Already claimed" || message === "No tickets available") ? 409 : 500;
    return c.json({ ok: false, error: message }, status);
  } finally {
    claimInFlight.delete(lockKey);
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
