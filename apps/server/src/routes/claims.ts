import { Hono } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";
import { verifyMessage } from "ethers";
import type { Hex0x, SealedBox, PaymentProof } from "@woco/shared";
import { PASSKEY_CLAIM_MAX_AGE_MS, PASSKEY_CLAIM_PREFIX, USDC_ADDRESSES, CHAIN_NAMES } from "@woco/shared";
import type { AppEnv } from "../types.js";
import { claimTicket, hashEmail, hashEmailLegacy, getClaimStatus, type ClaimIdentifier } from "../lib/event/claim-service.js";
import type { ClaimResult } from "../lib/event/claim-service.js";
import { getEvent } from "../lib/event/service.js";
import { verifyPayment } from "../lib/payment/verify.js";
import { getEscrowAddress } from "../lib/payment/constants.js";
import { usdToETH, usdToETHWithSlippage, getETHPriceUSD } from "../lib/payment/eth-price.js";
import { checkAndConsumeTxHash } from "../lib/payment/tx-registry.js";
import { extractDelegation, verifyDelegation } from "../lib/auth/verify-delegation.js";

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

/** Build an email claim identifier, including legacy hash for backward-compat dedup */
function buildEmailIdentifier(email: string): ClaimIdentifier {
  const emailHash = hashEmail(email);
  const legacyHash = hashEmailLegacy(email);
  return {
    type: "email",
    email,
    emailHash,
    // Only include legacy hash if it differs (i.e., EMAIL_HASH_SECRET is set)
    ...(legacyHash !== emailHash ? { legacyEmailHash: legacyHash } : {}),
  };
}

/** Max clock skew between client and server (5 minutes) — matches middleware/auth.ts */
const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

/** Resolve ALLOWED_HOSTS with the same rules as requireAuth middleware. */
function resolveAllowedHosts(): string[] | undefined {
  const raw = process.env.ALLOWED_HOSTS;
  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("ALLOWED_HOSTS is not set. Refusing wallet claim without host binding.");
    }
    return ["localhost:5173", "localhost:3001"];
  }
  if (raw.trim() === "*") return undefined;
  return raw.split(",").map((h) => h.trim()).filter(Boolean);
}

// POST /api/events/:eventId/series/:seriesId/claim
// Wallet claims: authenticated (session delegation proves address ownership)
// Email claims: unauthenticated but rate-limited by IP
claims.post("/:eventId/series/:seriesId/claim", async (c) => {
  const seriesId = c.req.param("seriesId");

  // Read the raw body once. We need both the parsed form (for mode dispatch)
  // and the raw text (for wallet mode's session signature verification).
  let rawBodyText: string;
  let rawBody: Record<string, unknown>;
  try {
    rawBodyText = await c.req.text();
    rawBody = rawBodyText.length > 0 ? JSON.parse(rawBodyText) : {};
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const mode = (rawBody.mode as string) || "wallet";

  let identifier: ClaimIdentifier;

  if (mode === "wallet") {
    // Wallet claims use the header-based auth v2 format (see middleware/auth.ts)
    const sessionAddress = c.req.header("x-session-address");
    const sessionSig = c.req.header("x-session-sig");
    const sessionNonce = c.req.header("x-session-nonce");
    const sessionTimestamp = c.req.header("x-session-timestamp");

    if (!sessionAddress || !sessionSig || !sessionNonce || !sessionTimestamp) {
      return c.json(
        { ok: false, error: "Wallet claims require session auth headers (X-Session-Address / Sig / Nonce / Timestamp)" },
        401,
      );
    }

    // Timestamp freshness
    const tsNum = Number(sessionTimestamp);
    if (!Number.isFinite(tsNum)) {
      return c.json({ ok: false, error: "Invalid X-Session-Timestamp" }, 401);
    }
    if (Math.abs(Date.now() - tsNum) > MAX_TIMESTAMP_SKEW_MS) {
      return c.json({ ok: false, error: "Session timestamp out of window" }, 401);
    }

    // Delegation (header only)
    const delegation = extractDelegation(c.req.raw);
    if (!delegation) {
      return c.json({ ok: false, error: "Missing X-Session-Delegation" }, 401);
    }

    const allowedHosts = resolveAllowedHosts();
    const result = verifyDelegation(delegation, sessionAddress, allowedHosts);
    if (!result.valid) {
      return c.json({ ok: false, error: result.error }, 403);
    }

    // Rebuild the canonical challenge and verify the per-request signature
    const pathForChallenge = new URL(c.req.url).pathname + new URL(c.req.url).search;
    const bodyHash = createHash("sha256").update(rawBodyText, "utf-8").digest("hex");
    const challenge = [
      "woco-session-v1",
      "POST",
      pathForChallenge,
      sessionTimestamp,
      sessionNonce,
      bodyHash,
    ].join("\n");

    try {
      const signerAddr = verifyMessage(challenge, sessionSig);
      if (signerAddr.toLowerCase() !== result.sessionAddress!.toLowerCase()) {
        return c.json({ ok: false, error: "Session signature does not match session key" }, 403);
      }
    } catch {
      return c.json({ ok: false, error: "Invalid session signature" }, 403);
    }

    // Use the verified parent address — NOT any address from the request body
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

    identifier = buildEmailIdentifier(email);

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
    if (!expected || !apiKey) {
      return c.json({ ok: false, error: "Invalid API key" }, 403);
    }
    // Constant-time comparison to prevent timing side-channel leakage
    const keyBuf = Buffer.from(apiKey);
    const expectedBuf = Buffer.from(expected);
    if (keyBuf.length !== expectedBuf.length || !timingSafeEqual(keyBuf, expectedBuf)) {
      return c.json({ ok: false, error: "Invalid API key" }, 403);
    }
    // API mode uses wallet address or email passed by organizer
    const address = rawBody.walletAddress as string;
    const email = rawBody.email as string;
    if (address) {
      identifier = { type: "wallet", address: address.toLowerCase() as Hex0x };
    } else if (email) {
      identifier = buildEmailIdentifier(email);
    } else {
      return c.json({ ok: false, error: "API mode requires walletAddress or email" }, 400);
    }

  } else {
    return c.json({ ok: false, error: `Unknown claim mode: ${mode}` }, 400);
  }

  const encryptedOrder = rawBody.encryptedOrder as SealedBox | undefined;
  const paymentProof = rawBody.paymentProof as PaymentProof | undefined;

  // ---------------------------------------------------------------------------
  // Payment verification — if series requires payment, validate proof
  // ---------------------------------------------------------------------------
  const eventId = c.req.param("eventId");
  const event = await getEvent(eventId);
  if (!event) {
    return c.json({ ok: false, error: "Event not found" }, 404);
  }
  const series = event.series.find((s) => s.seriesId === seriesId);
  if (!series) {
    return c.json({ ok: false, error: "Series not found" }, 404);
  }

  if (series.payment) {
    // Series requires crypto payment
    if (!paymentProof) {
      // For USD-priced events, include the current ETH equivalent
      let ethEquivalent: string | undefined;
      let ethPriceUSD: number | undefined;
      if (series.payment.currency === "USD") {
        try {
          ethPriceUSD = await getETHPriceUSD();
          ethEquivalent = await usdToETH(series.payment.price);
        } catch { /* price feed unavailable — client can fetch independently */ }
      }

      // Return 402 with payment requirements
      return c.json({
        ok: false,
        error: "Payment required",
        paymentRequired: {
          price: series.payment.price,
          currency: series.payment.currency,
          recipientAddress: series.payment.recipientAddress,
          acceptedChains: series.payment.acceptedChains,
          escrow: series.payment.escrow,
          ...(ethEquivalent ? { ethEquivalent, ethPriceUSD } : {}),
          chainDetails: series.payment.acceptedChains.map((chainId) => ({
            chainId,
            name: CHAIN_NAMES[chainId],
            ...(series.payment!.currency === "USDC"
              ? { usdcAddress: USDC_ADDRESSES[chainId] }
              : {}),
            ...(series.payment!.escrow ? { escrowAddress: getEscrowAddress(chainId) } : {}),
          })),
        },
      }, 402);
    }

    // Validate the chain is accepted
    if (!series.payment.acceptedChains.includes(paymentProof.chainId)) {
      return c.json({
        ok: false,
        error: `Chain ${paymentProof.chainId} not accepted. Use: ${series.payment.acceptedChains.map((c) => CHAIN_NAMES[c]).join(", ")}`,
      }, 400);
    }

    // Determine recipient: escrow contract or organiser's address
    const recipient = series.payment.escrow
      ? getEscrowAddress(paymentProof.chainId)
      : series.payment.recipientAddress;
    if (!recipient) {
      return c.json({ ok: false, error: "Escrow not configured for this chain" }, 500);
    }

    // Verify the on-chain payment
    if (paymentProof.type === "tx") {
      let verifyAmount = series.payment.price;
      let verifyCurrency: "ETH" | "USDC" = series.payment.currency === "USDC" ? "USDC" : "ETH";

      // USD-priced: convert to ETH with slippage tolerance (3%)
      if (series.payment.currency === "USD") {
        verifyCurrency = "ETH";
        verifyAmount = await usdToETHWithSlippage(series.payment.price);
      }

      // Determine who is expected to have signed the payment tx.
      // Wallet mode: the verified parentAddress (authenticated by session sig).
      // Email / passkey / API: the client must supply a claimerProof — an EIP-191
      // signature by the paying wallet over the canonical claim context. We
      // recover the signer and use it as expectedFrom.
      let expectedFrom: Hex0x;
      if (identifier.type === "wallet") {
        expectedFrom = identifier.address;
      } else {
        // Non-wallet claim: require claimerProof binding the tx to this claim.
        if (!paymentProof.claimerProof || !paymentProof.txHash) {
          return c.json({
            ok: false,
            error: "Payment claimerProof required for non-wallet claims",
          }, 400);
        }
        const claimContext = `woco-payment-v1:${paymentProof.txHash}:${eventId}:${seriesId}:${identifier.emailHash}`;
        try {
          const recovered = verifyMessage(claimContext, paymentProof.claimerProof);
          expectedFrom = recovered.toLowerCase() as Hex0x;
        } catch {
          return c.json({ ok: false, error: "Invalid claimerProof signature" }, 403);
        }
      }

      const verification = await verifyPayment(paymentProof, {
        amount: verifyAmount,
        currency: verifyCurrency,
        recipient,
        expectedFrom,
      });
      if (!verification.valid) {
        return c.json({ ok: false, error: `Payment verification failed: ${verification.error}` }, 402);
      }

      // Prevent txHash replay — reject if this tx was already used for another claim
      if (paymentProof.txHash && !checkAndConsumeTxHash(paymentProof.txHash)) {
        return c.json({ ok: false, error: "This transaction has already been used for a claim" }, 409);
      }
    }
    // x402 proofs are handled by the x402 middleware layer (Phase 6)
  }

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
    const ticket: ClaimResult = await queueSeriesClaim(seriesId, () =>
      claimTicket({ seriesId, identifier, encryptedOrder }),
    );

    // Approval flow: strip internal _pendingId and return pending state
    if (ticket.approvalStatus === "pending") {
      const { _pendingId, ...ticketForClient } = ticket;
      return c.json({ ok: true, ticket: ticketForClient, edition: ticket.edition, approvalPending: true, pendingId: _pendingId });
    }

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
  const userEmailHash = c.req.query("emailHash");

  try {
    const status = await getClaimStatus(seriesId, userAddress || undefined, userEmailHash || undefined);
    return c.json({ ok: true, data: status });
  } catch (err) {
    console.error("[api] getClaimStatus error:", err);
    const message = err instanceof Error ? err.message : "Failed to get claim status";
    return c.json({ ok: false, error: message }, 500);
  }
});

export { claims };
