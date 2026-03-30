import { Hono } from "hono";
import { verifyMessage } from "ethers";
import type { Hex0x, SealedBox, PaymentProof, PaymentConfig } from "@woco/shared";
import { PASSKEY_CLAIM_MAX_AGE_MS, PASSKEY_CLAIM_PREFIX, USDC_ADDRESSES, CHAIN_NAMES } from "@woco/shared";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { claimTicket, hashEmail, getClaimStatus, addToUserCollection, addToEmailCollection, type ClaimIdentifier } from "../lib/event/claim-service.js";
import type { ClaimResult } from "../lib/event/claim-service.js";
import { getEvent } from "../lib/event/service.js";
import { verifyPayment } from "../lib/payment/verify.js";
import { getEscrowAddress } from "../lib/payment/constants.js";
import { usdToETH, usdToETHWithSlippage, getETHPriceUSD } from "../lib/payment/eth-price.js";

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

      const verification = await verifyPayment(paymentProof, {
        amount: verifyAmount,
        currency: verifyCurrency,
        recipient,
      });
      if (!verification.valid) {
        return c.json({ ok: false, error: `Payment verification failed: ${verification.error}` }, 402);
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

// ---------------------------------------------------------------------------
// Mock payment page (GET) — returns a self-contained HTML page
// ---------------------------------------------------------------------------

claims.get("/:eventId/series/:seriesId/mock-payment-page", async (c) => {
  const eventId = c.req.param("eventId");
  const seriesId = c.req.param("seriesId");
  const { email = "", walletAddress = "", returnUrl = "", amount = "", currency = "GBP" } = c.req.query();

  // Fetch event info for the banner
  let eventTitle = "Event";
  let seriesName = "Ticket";
  let seriesPrice = amount;
  try {
    const ev = await getEvent(eventId);
    if (ev) {
      eventTitle = ev.title;
      const s = ev.series.find(s => s.seriesId === seriesId);
      if (s) { seriesName = s.name; if (!seriesPrice) seriesPrice = String(s.price); }
    }
  } catch { /* proceed with defaults */ }

  const postUrl = `${new URL(c.req.url).origin}/api/events/${eventId}/series/${seriesId}/mock-payment`;
  const safeEmail = email.replace(/"/g, "&quot;");
  const safeWallet = walletAddress.replace(/"/g, "&quot;");
  const safeReturn = returnUrl.replace(/"/g, "&quot;");

  const priceDisplay = (seriesPrice && Number(seriesPrice) > 0)
    ? `${seriesPrice} ${currency}`
    : "Free (demo)";

  const showIdentity = !!walletAddress;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Complete Registration – ${eventTitle}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #0f0f13; color: #e1e1e6; min-height: 100dvh; display: flex; align-items: flex-start; justify-content: center; padding: 2rem 1rem; }
  .card { width: 100%; max-width: 480px; }
  .banner { background: #1a1a24; border: 1px solid #2a2a38; border-radius: 12px; padding: 1.25rem 1.5rem; margin-bottom: 1.5rem; }
  .banner-label { font-size: 0.7rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #888; margin-bottom: 0.375rem; }
  .banner-title { font-size: 1.125rem; font-weight: 700; color: #e1e1e6; }
  .banner-series { font-size: 0.875rem; color: #aaa; margin-top: 0.25rem; }
  .price-row { display: flex; align-items: center; justify-content: space-between; margin-top: 0.875rem; padding-top: 0.875rem; border-top: 1px solid #2a2a38; }
  .price-label { font-size: 0.8125rem; color: #888; }
  .price-value { font-size: 1rem; font-weight: 700; color: #7c6cf0; }
  .section-title { font-size: 0.75rem; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: #888; margin-bottom: 0.75rem; }
  .field-group { margin-bottom: 1.25rem; }
  label { display: block; font-size: 0.8125rem; color: #aaa; margin-bottom: 0.375rem; }
  input[type=email], input[type=text] { width: 100%; padding: 0.5625rem 0.875rem; background: #1a1a24; border: 1px solid #2a2a38; border-radius: 8px; color: #e1e1e6; font-size: 0.875rem; font-family: inherit; transition: border-color 0.15s; }
  input:focus { outline: none; border-color: #7c6cf0; }
  .identity-box { background: #1a1a24; border: 1px solid #2a2a38; border-radius: 12px; padding: 1.25rem 1.5rem; margin-bottom: 1.5rem; }
  .identity-title { font-size: 0.9375rem; font-weight: 600; color: #e1e1e6; margin-bottom: 0.25rem; }
  .identity-subtitle { font-size: 0.8125rem; color: #888; margin-bottom: 1rem; }
  .identity-option { display: flex; align-items: flex-start; gap: 0.75rem; padding: 0.75rem 0; border-top: 1px solid #2a2a38; }
  .identity-option:first-of-type { border-top: none; }
  .identity-option input[type=checkbox] { margin-top: 0.125rem; flex-shrink: 0; accent-color: #7c6cf0; width: 1rem; height: 1rem; }
  .identity-option-body { flex: 1; min-width: 0; }
  .identity-option-label { font-size: 0.875rem; font-weight: 500; color: #e1e1e6; margin-bottom: 0.125rem; }
  .identity-option-desc { font-size: 0.75rem; color: #888; line-height: 1.5; }
  .alt-wallet-input { margin-top: 0.5rem; }
  .submit-btn { width: 100%; padding: 0.75rem; background: #7c6cf0; color: #fff; font-size: 0.9375rem; font-weight: 600; border-radius: 8px; cursor: pointer; transition: background 0.15s; border: none; font-family: inherit; }
  .submit-btn:hover { background: #6a5ce0; }
  .submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .demo-note { font-size: 0.75rem; color: #555; text-align: center; margin-top: 1rem; }
  #error-msg { color: #f87171; font-size: 0.8125rem; margin-top: 0.75rem; display: none; }
</style>
</head>
<body>
<div class="card">
  <div class="banner">
    <div class="banner-label">Registration</div>
    <div class="banner-title">${eventTitle}</div>
    <div class="banner-series">${seriesName}</div>
    <div class="price-row">
      <span class="price-label">Amount</span>
      <span class="price-value">${priceDisplay}</span>
    </div>
  </div>

  <form id="pay-form">
    <input type="hidden" name="returnUrl" value="${safeReturn}"/>

    <div class="field-group">
      <div class="section-title">Contact details</div>
      <label for="email">Email address *</label>
      <input type="email" id="email" name="email" value="${safeEmail}" required placeholder="your@email.com"/>
    </div>

    ${showIdentity ? `
    <div class="identity-box">
      <div class="identity-title">How do you want to use this ticket in future?</div>
      <div class="identity-subtitle">Your ticket can be linked to one or more identity anchors. This determines which apps and platforms can verify your attendance.</div>

      <div class="identity-option">
        <input type="checkbox" id="linkWallet" name="linkWallet" value="1" checked/>
        <div class="identity-option-body">
          <div class="identity-option-label">Save to wallet (${safeWallet.slice(0, 6)}…${safeWallet.slice(-4)})</div>
          <div class="identity-option-desc">Access gated apps, forums, and on-chain spaces with this wallet.</div>
        </div>
      </div>

      <div class="identity-option">
        <input type="checkbox" id="linkEmail" name="linkEmail" value="1" checked/>
        <div class="identity-option-body">
          <div class="identity-option-label">Save to email</div>
          <div class="identity-option-desc">For email-based platforms and as a backup. Your email isn't stored — only a hash.</div>
        </div>
      </div>

      <div class="identity-option">
        <input type="checkbox" id="useAltWallet" name="useAltWallet" value="1" onchange="document.getElementById('altWalletWrap').style.display=this.checked?'block':'none'"/>
        <div class="identity-option-body">
          <div class="identity-option-label">Use a different wallet for access</div>
          <div class="identity-option-desc">If your paying wallet isn't your everyday wallet.</div>
          <div id="altWalletWrap" class="alt-wallet-input" style="display:none">
            <input type="text" name="altWallet" placeholder="0x…" style="margin-top:0.375rem"/>
          </div>
        </div>
      </div>
    </div>
    <input type="hidden" name="walletAddress" value="${safeWallet}"/>
    ` : ""}

    <button type="submit" class="submit-btn" id="submit-btn">Confirm Payment</button>
    <p id="error-msg"></p>
    <p class="demo-note">This is a mock payment page for testing. No real payment is processed.</p>
  </form>
</div>

<script>
document.getElementById("pay-form").addEventListener("submit", async function(e) {
  e.preventDefault();
  const btn = document.getElementById("submit-btn");
  const errEl = document.getElementById("error-msg");
  btn.disabled = true;
  btn.textContent = "Processing…";
  errEl.style.display = "none";

  const fd = new FormData(e.target);
  const body = {
    email: fd.get("email") || undefined,
    walletAddress: fd.get("walletAddress") || undefined,
    linkWallet: fd.get("linkWallet") === "1",
    linkEmail: fd.get("linkEmail") === "1",
    altWallet: fd.get("altWallet") || undefined,
  };

  try {
    const resp = await fetch("${postUrl}", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await resp.json();
    if (json.ok) {
      const returnUrl = fd.get("returnUrl");
      const sep = returnUrl && returnUrl.includes("?") ? "&" : "?";
      window.location.href = (returnUrl || "/") + sep + "claimed=1&edition=" + (json.edition || "");
    } else {
      errEl.textContent = json.error || "Payment failed — please try again.";
      errEl.style.display = "block";
      btn.disabled = false;
      btn.textContent = "Confirm Payment";
    }
  } catch {
    errEl.textContent = "Network error — please try again.";
    errEl.style.display = "block";
    btn.disabled = false;
    btn.textContent = "Confirm Payment";
  }
});
</script>
</body>
</html>`;

  return c.html(html);
});

// ---------------------------------------------------------------------------
// Mock payment POST — mints ticket, writes dual-feed identity association
// ---------------------------------------------------------------------------

claims.post("/:eventId/series/:seriesId/mock-payment", async (c) => {
  const seriesId = c.req.param("seriesId");

  let body: {
    email?: string;
    walletAddress?: string;
    linkWallet?: boolean;
    linkEmail?: boolean;
    altWallet?: string;
    encryptedOrder?: SealedBox;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const { email, walletAddress, linkWallet, linkEmail, altWallet, encryptedOrder } = body;

  if (!email && !walletAddress) {
    return c.json({ ok: false, error: "email or walletAddress is required" }, 400);
  }

  // Build primary claim identifier — prefer email as the "payment contact"
  let identifier: ClaimIdentifier;
  if (email) {
    identifier = { type: "email", email, emailHash: hashEmail(email) };
  } else {
    identifier = { type: "wallet", address: (walletAddress as Hex0x).toLowerCase() as Hex0x };
  }

  // Rate-limit mock-payment same as email claims
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    || c.req.header("cf-connecting-ip")
    || "unknown";
  if (identifier.type === "email" && !checkEmailRateLimit(ip)) {
    return c.json({ ok: false, error: "Too many registrations. Please try again later." }, 429);
  }

  const identifierKey = identifier.type === "wallet"
    ? (identifier.address as string).toLowerCase()
    : identifier.emailHash;
  const lockKey = `${seriesId}:${identifierKey}`;

  if (claimInFlight.has(lockKey)) {
    return c.json({ ok: false, error: "Registration already in progress — please wait" }, 429);
  }
  claimInFlight.add(lockKey);

  try {
    const ticket: ClaimResult = await queueSeriesClaim(seriesId, () =>
      claimTicket({ seriesId, identifier, encryptedOrder }),
    );

    if (ticket.approvalStatus === "pending") {
      const { _pendingId, ...ticketForClient } = ticket;
      return c.json({ ok: true, ticket: ticketForClient, edition: ticket.edition, approvalPending: true, pendingId: _pendingId });
    }

    const edition = ticket.edition;
    const eventId = c.req.param("eventId");
    const claimedRef = ticket.originalPodHash; // best available ref
    const claimedAt = ticket.claimedAt;

    const entry = { seriesId, eventId, edition, claimedRef, claimedAt };

    // Dual-feed identity association (runs in background, non-critical)
    const collectionPromises: Promise<void>[] = [];

    if (linkWallet && walletAddress) {
      collectionPromises.push(
        addToUserCollection(walletAddress.toLowerCase(), entry)
          .catch(err => console.error("[mock-payment] wallet collection error:", err)),
      );
    }

    if (altWallet && altWallet.trim().startsWith("0x")) {
      collectionPromises.push(
        addToUserCollection(altWallet.trim().toLowerCase(), entry)
          .catch(err => console.error("[mock-payment] alt wallet collection error:", err)),
      );
    }

    if (linkEmail && email) {
      const emailHash = hashEmail(email);
      collectionPromises.push(
        addToEmailCollection(emailHash, entry)
          .catch(err => console.error("[mock-payment] email collection error:", err)),
      );
    }

    // Fire and forget
    Promise.all(collectionPromises).catch(() => {});

    return c.json({ ok: true, ticket, edition });
  } catch (err) {
    console.error("[api] mock-payment error:", err);
    const message = err instanceof Error ? err.message : "Registration failed";
    const status = (message === "Already claimed" || message === "No tickets available") ? 409 : 500;
    return c.json({ ok: false, error: message }, status);
  } finally {
    claimInFlight.delete(lockKey);
  }
});

export { claims };
