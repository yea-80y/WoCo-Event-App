import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppEnv } from "./types.js";
import { requireAuth } from "./middleware/auth.js";
import { revokeSession, revokeAllSessions } from "./lib/auth/revocation.js";
import { events } from "./routes/events.js";
import { claims } from "./routes/claims.js";
import { orders } from "./routes/orders.js";
import { approvals } from "./routes/approvals.js";
import { collection } from "./routes/collection.js";
import { admin } from "./routes/admin.js";
import { siteRoute } from "./routes/site.js";
import { profiles } from "./routes/profiles.js";
import { broadcast } from "./routes/broadcast.js";
import { domains } from "./routes/domains.js";
import { stripeRoutes } from "./routes/stripe.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Startup safety checks
// ---------------------------------------------------------------------------
// ALLOWED_HOSTS is the primary replay-protection guard for session delegations
// (SESSION_DOMAIN has no chainId — host binding is what prevents cross-origin
// delegation reuse). Refuse to boot in production without it.
if (process.env.NODE_ENV === "production" && !process.env.ALLOWED_HOSTS) {
  console.error(
    "\n[startup] FATAL: ALLOWED_HOSTS is not set in production.\n" +
    "  Set ALLOWED_HOSTS=host1,host2 (e.g. gateway.woco-net.com,woco.eth.limo)\n" +
    "  This is required for session delegation replay protection.\n",
  );
  process.exit(1);
}
if (!process.env.ALLOWED_HOSTS) {
  console.warn(
    "[startup] ALLOWED_HOSTS not set — using dev default (localhost:5173,localhost:3001)",
  );
}

// EMAIL_HASH_SECRET is the HMAC key for hashing claimer emails before they
// land on publicly-readable Swarm feeds. Without it, hashes are unsalted
// SHA-256 and trivially reversible via rainbow tables. Refuse to boot without
// it in ANY environment — the dev fallback was removed in Round 3 (2026-04-09).
if (!process.env.EMAIL_HASH_SECRET) {
  console.error(
    "\n[startup] FATAL: EMAIL_HASH_SECRET is not set.\n" +
    "  Generate one with:\n" +
    "    node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n" +
    "  and add to apps/server/.env as EMAIL_HASH_SECRET=<hex>\n" +
    "  Required for privacy-safe email hashing on public Swarm feeds.\n",
  );
  process.exit(1);
}

const app = new Hono<AppEnv>();

// CORS - allow frontend dev server
app.use(
  "*",
  cors({
    origin: (origin) => origin || "*",
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "X-Session-Address",
      "X-Session-Delegation",
      "X-Session-Sig",
      "X-Session-Nonce",
      "X-Session-Timestamp",
      "X-PAYMENT",
    ],
    exposeHeaders: [
      "PAYMENT-REQUIRED",
      "X-FACILITATOR-URL",
      "PAYMENT-RESPONSE",
    ],
  }),
);

// Health check
app.get("/api/health", (c) => c.json({ ok: true }));

// ETH price proxy — frontend can't call CoinGecko directly (CORS + rate limits)
app.get("/api/eth-price", async (c) => {
  try {
    const { getETHPriceUSD } = await import("./lib/payment/eth-price.js");
    const price = await getETHPriceUSD();
    return c.json({ ok: true, price });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to fetch ETH price";
    return c.json({ ok: false, error: msg });
  }
});

// Escrow contract addresses per chain — frontend needs these to send payment to the right contract
app.get("/api/payment/escrow-addresses", async (c) => {
  const { getEscrowAddress } = await import("./lib/payment/constants.js");
  const chainIds = [1, 8453, 10, 11155111] as const;
  const addresses: Record<number, string> = {};
  for (const chainId of chainIds) {
    const addr = getEscrowAddress(chainId);
    if (addr) addresses[chainId] = addr;
  }
  return c.json({ ok: true, addresses });
});

/**
 * Signed payment quote — server commits to an EXACT wei amount the user must
 * pay. Eliminates the dual-source price race between client and server reading
 * a moving oracle. Quote is HMAC-signed, short-TTL, and one-shot.
 *
 * Request body: { eventId, seriesId, chainId, currency, claimerAddress? }
 * Response: { ok: true, quote: PaymentQuote }
 */
app.post("/api/payment/quote", async (c) => {
  try {
    const body = (await c.req.json().catch(() => null)) as {
      eventId?: string;
      seriesId?: string;
      chainId?: number;
      currency?: "ETH" | "USDC";
      claimerAddress?: string;
    } | null;

    if (!body?.eventId || !body.seriesId || !body.chainId || !body.currency) {
      return c.json({ ok: false, error: "Missing eventId, seriesId, chainId, or currency" }, 400);
    }

    const { getEvent } = await import("./lib/event/service.js");
    const event = await getEvent(body.eventId);
    if (!event) return c.json({ ok: false, error: "Event not found" }, 404);

    const series = event.series.find((s) => s.seriesId === body.seriesId);
    if (!series) return c.json({ ok: false, error: "Series not found" }, 404);
    if (!series.payment) return c.json({ ok: false, error: "Series has no payment config" }, 400);
    if (!series.payment.cryptoEnabled) {
      return c.json({ ok: false, error: "Crypto payments not enabled for this series" }, 400);
    }

    const chainId = body.chainId as import("@woco/shared").PaymentChainId;
    if (!series.payment.acceptedChains.includes(chainId)) {
      return c.json({ ok: false, error: `Chain ${chainId} not accepted for this series` }, 400);
    }

    const { getEscrowAddress } = await import("./lib/payment/constants.js");
    const recipient = (series.payment.escrow
      ? getEscrowAddress(chainId)
      : series.payment.recipientAddress) as import("@woco/shared").Hex0x | undefined;
    if (!recipient) return c.json({ ok: false, error: "Recipient not configured for this chain" }, 500);

    const { parseUnits } = await import("ethers");
    const { fiatToETH } = await import("./lib/payment/eth-price.js");
    const { signQuote } = await import("./lib/payment/quote.js");

    let amountWei: string;
    if (body.currency === "ETH") {
      const ethStr = await fiatToETH(series.payment.price, series.payment.currency);
      amountWei = parseUnits(ethStr, 18).toString();
    } else if (body.currency === "USDC") {
      // USDC is dollar-pegged 1:1 — convert fiat→USD then to 6-dec atomic units.
      const { fiatToUSD } = await import("./lib/payment/eth-price.js");
      const usd = await fiatToUSD(series.payment.price, series.payment.currency);
      amountWei = parseUnits(usd.toFixed(6), 6).toString();
    } else {
      return c.json({ ok: false, error: "Unsupported currency" }, 400);
    }

    const quote = signQuote({
      seriesId: series.seriesId,
      chainId,
      currency: body.currency,
      recipient,
      amountWei,
      fiatPrice: series.payment.price,
      fiatCurrency: series.payment.currency,
      ...(body.claimerAddress ? { boundTo: body.claimerAddress } : {}),
    });

    return c.json({ ok: true, quote });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Quote failed";
    console.error("[quote] error:", err);
    return c.json({ ok: false, error: msg }, 500);
  }
});

// Serve embed iframe frame page
app.get("/embed/frame/:eventId", (c) => {
  const eventId = c.req.param("eventId").replace(/[^a-zA-Z0-9\-]/g, "");
  const claimMode = (c.req.query("claim-mode") || "both").replace(/[^a-z]/g, "");
  const theme = (c.req.query("theme") || "dark").replace(/[^a-z]/g, "");
  const showImage = c.req.query("show-image") !== "false" ? "true" : "false";
  const showDesc = c.req.query("show-description") !== "false" ? "true" : "false";
  const apiUrl = "https://events-api.woco-net.com";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>* { margin: 0; padding: 0; box-sizing: border-box; } html, body { background: transparent; }</style>
</head>
<body>
  <script src="${apiUrl}/embed/woco-embed.js?v=7"><\/script>
  <woco-tickets
    event-id="${eventId}"
    api-url="${apiUrl}"
    claim-mode="${claimMode}"
    theme="${theme}"
    show-image="${showImage}"
    show-description="${showDesc}"
  ></woco-tickets>
  <script>
    var widget = document.querySelector('woco-tickets');

    // Forward woco-claim events to parent page
    widget.addEventListener('woco-claim', function(e) {
      window.parent.postMessage({ type: 'woco-claim', detail: e.detail }, '*');
    });

    // Auto-resize: notify parent of height changes
    function notifyResize() {
      var h = widget.getBoundingClientRect().height || document.body.scrollHeight;
      window.parent.postMessage({ type: 'woco-resize', height: Math.ceil(h) }, '*');
    }
    new ResizeObserver(notifyResize).observe(widget);
    setTimeout(notifyResize, 300);
  <\/script>
</body>
</html>`;

  c.header("Content-Type", "text/html");
  c.header("X-Frame-Options", "ALLOWALL");
  c.header("Cache-Control", "no-store");
  return c.body(html);
});

// Serve embed widget JS
app.get("/embed/woco-embed.js", (c) => {
  try {
    const embedPath = resolve(__dirname, "../../../packages/embed/dist/woco-embed.js");
    const js = readFileSync(embedPath, "utf-8");
    c.header("Content-Type", "application/javascript");
    c.header("Cache-Control", "public, max-age=3600");
    c.header("Access-Control-Allow-Origin", "*");
    return c.body(js);
  } catch {
    return c.text("Embed widget not built. Run: npm run build:embed", 404);
  }
});

// Authenticated: returns the verified parent address
app.post("/api/auth/whoami", requireAuth, (c) => {
  return c.json({
    ok: true,
    data: {
      parentAddress: c.get("parentAddress"),
      sessionAddress: c.get("sessionAddress"),
    },
  });
});

// Revoke current session (requires valid delegation to prove ownership)
app.post("/api/auth/revoke-session", requireAuth, (c) => {
  // requireAuth already verified the delegation — read its nonce from the header.
  const header = c.req.header("x-session-delegation");
  if (!header) {
    return c.json({ ok: false, error: "Missing X-Session-Delegation" }, 400);
  }
  try {
    const delegation = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
    const nonce = delegation?.message?.nonce;
    const expiresAt = delegation?.message?.expiresAt;
    if (!nonce || !expiresAt) {
      return c.json({ ok: false, error: "Could not extract session nonce/expiry" }, 400);
    }
    revokeSession(nonce, expiresAt);
    return c.json({ ok: true, message: "Session revoked" });
  } catch {
    return c.json({ ok: false, error: "Invalid delegation header" }, 400);
  }
});

// Revoke all sessions for the authenticated parent address
app.post("/api/auth/revoke-all", requireAuth, (c) => {
  const parentAddress = c.get("parentAddress") as string;
  revokeAllSessions(parentAddress);
  return c.json({ ok: true, message: "All sessions revoked" });
});

// Event routes
app.route("/api/events", events);
app.route("/api/events", claims);
app.route("/api/events", orders);
app.route("/api/events", approvals);
app.route("/api/events", broadcast);

// Collection routes (authenticated)
app.route("/api/collection", collection);

// Admin / setup routes (unauthenticated — no private data exposed)
app.route("/api/admin", admin);
app.route("/api/site", siteRoute);

// Custom domain routes
app.route("/api/domains", domains);

// Stripe Connect routes (organiser onboarding + attendee checkout)
app.route("/api/stripe", stripeRoutes);

// Profile routes
app.route("/api/profile", profiles);

const port = Number(process.env.PORT) || 3001;
console.log(`WoCo server listening on :${port}`);
serve({ fetch: app.fetch, port });
