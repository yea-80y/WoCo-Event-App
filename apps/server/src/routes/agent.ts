/**
 * Agent commerce surface — `/api/agent/*`.
 *
 * The HTTP face of the bounded non-custodial agent wallet: an autonomous agent
 * discovers WoCo events, learns the exact USDC price + organiser recipient, and
 * buys a ticket by drawing against a spend permission the user granted to the
 * agent's OWN key (see lib/agent/spend-authority.ts for the custody model).
 *
 * AUTH: these endpoints are intentionally UNAUTHENTICATED. The cryptographic
 * authorization is the on-chain draw itself — only a key the user granted can
 * produce a valid USDC transfer userKernel→organiser, and the ticket always
 * mints to that funding Kernel (proved by the Transfer log `from`). The server
 * is never in the auth/funds path. Lightly IP-rate-limited to bound abuse of the
 * on-chain reads.
 *
 * x402: /buy follows an x402-style 402 handshake — call it without a settlement
 * and you get HTTP 402 + a PAYMENT-REQUIRED descriptor; pay (draw) then retry
 * with the settlement tx. The settlement scheme is our non-custodial
 * spend-permission draw rather than x402's default EIP-3009 hot-wallet transfer.
 */

import { Hono } from "hono";
import { parseUnits } from "ethers";
import type { AppEnv } from "../types.js";
import type { Context, Next } from "hono";
import { USDC_ADDRESSES, FEATURES } from "@woco/shared";
import type { Hex0x, PaymentChainId, SealedBox } from "@woco/shared";
import { getEvent, listEvents } from "../lib/event/service.js";
import { getClaimStatus } from "../lib/event/claim-service.js";
import { fiatToUSD } from "../lib/payment/eth-price.js";
import { checkPodGate, gatePhase, gateNeedsClaimCount } from "../lib/pod/gate-check.js";
import type { PodGate, PodGateGroup } from "@woco/shared";
import {
  agentBudgetParams,
  settleAgentTicketPurchase,
  AGENT_SPEND_CHAIN_ID,
} from "../lib/agent/spend-authority.js";
import { issuePurchaseIntent, peekPurchaseIntent, deletePurchaseIntent } from "../lib/agent/purchase-intent.js";

export const agentRouter = new Hono<AppEnv>();

// Kill switch for the agent money path (#41 — settlement is on-chain, the ticket still
// mints Swarm-only). Discovery stays open: /events reads nothing and moves nothing.
agentRouter.use("/grant-params", agentCommerceGate);
agentRouter.use("/quote", agentCommerceGate);
agentRouter.use("/buy", agentCommerceGate);

async function agentCommerceGate(c: Context<AppEnv>, next: Next) {
  if (!FEATURES.agentCommerceAllowed) {
    return c.json({ ok: false, error: "Agent purchases are not available" }, 403);
  }
  await next();
}

// --- Minimal IP rate limit (on-chain reads cost) -------------------------------
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
const hits = new Map<string, { count: number; resetAt: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const e = hits.get(ip);
  if (!e || now > e.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  e.count += 1;
  return e.count > RATE_LIMIT;
}
function clientIp(c: { req: { header: (k: string) => string | undefined } }): string {
  return (c.req.header("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}

// ---------------------------------------------------------------------------
// Resolve a series' USDC price + organiser recipient (the agent's draw target).
// ---------------------------------------------------------------------------

interface ResolvedPayment {
  organiser: Hex0x;
  usdcAddress: Hex0x;
  amountAtomic: string;
  chainId: PaymentChainId;
  fiatPrice: string;
  currency: string;
  seriesName: string;
  eventTitle: string;
  /** POD-holdings gate on this series, if any — enforced at /buy before mint. */
  gate?: PodGate | PodGateGroup;
}

type Resolved =
  | { ok: true; data: ResolvedPayment }
  | { ok: false; error: string; code: 400 | 404 };

/**
 * Resolve and PRICE a series for an agent purchase on the locked Arb Sepolia
 * USDC rail. Rejects anything the bounded-draw rail can't settle: free series,
 * crypto-disabled, escrow (no non-custodial split yet), or chains without USDC.
 * The amount is computed here server-side — the authoritative figure the draw
 * must match (recomputed identically at settle time, never trusted from a quote).
 */
async function resolveSeriesPayment(eventId: string, seriesId: string): Promise<Resolved> {
  const event = await getEvent(eventId);
  if (!event) return { ok: false, error: "Event not found", code: 404 };
  const series = event.series.find((s) => s.seriesId === seriesId);
  if (!series) return { ok: false, error: "Series not found", code: 404 };

  const pay = series.payment;
  if (!pay || !pay.cryptoEnabled) {
    return { ok: false, error: "Series does not accept crypto payment", code: 400 };
  }
  if (pay.escrow) {
    return { ok: false, error: "Escrow series are not yet supported on the agent rail", code: 400 };
  }
  if (!pay.acceptedChains.includes(AGENT_SPEND_CHAIN_ID as PaymentChainId)) {
    return {
      ok: false,
      error: `Agent purchases settle on Arbitrum Sepolia (${AGENT_SPEND_CHAIN_ID}); this series does not accept it`,
      code: 400,
    };
  }
  const usdc = USDC_ADDRESSES[AGENT_SPEND_CHAIN_ID as PaymentChainId];
  if (!usdc) return { ok: false, error: "USDC not configured for the spend chain", code: 400 };

  const usd = await fiatToUSD(pay.price, pay.currency);
  const amountAtomic = parseUnits(usd.toFixed(6), 6).toString();
  if (BigInt(amountAtomic) <= 0n) {
    return { ok: false, error: "Series price must be positive", code: 400 };
  }

  return {
    ok: true,
    data: {
      organiser: pay.recipientAddress.toLowerCase() as Hex0x,
      usdcAddress: usdc.toLowerCase() as Hex0x,
      amountAtomic,
      chainId: AGENT_SPEND_CHAIN_ID as PaymentChainId,
      fiatPrice: pay.price,
      currency: pay.currency,
      seriesName: series.name,
      eventTitle: event.title,
      gate: series.gate,
    },
  };
}

/**
 * Enforce the series POD-holdings gate against the funding/claiming Kernel,
 * mirroring the events claim route (claims.ts). Fails closed. Returns null when
 * the gate is satisfied (or absent), or an error string to reject with.
 */
async function gateRejection(
  gate: PodGate | PodGateGroup | undefined,
  seriesId: string,
  userKernel: Hex0x,
): Promise<string | null> {
  if (!gate) return null;
  const tierClaimed = gateNeedsClaimCount(gate)
    ? (await getClaimStatus(seriesId)).claimed
    : undefined;
  const phase = gatePhase(gate, { tierClaimed });
  if (phase === "closed") return "This ticket is not currently available.";
  if (phase === "holders-only") {
    const decision = await checkPodGate(gate, userKernel, { tierClaimed });
    if (!decision.ok) return decision.reason ?? "This ticket is gated — the required POD is not held.";
  }
  return null; // "open" phase or gate satisfied
}

/** x402-style PAYMENT-REQUIRED descriptor (base64 JSON) for the 402 handshake. */
function paymentRequiredHeader(r: ResolvedPayment, eventId: string, seriesId: string): string {
  const body = {
    x402Version: 2,
    scheme: "spend-permission",
    network: `eip155:${r.chainId}`,
    asset: r.usdcAddress,
    payTo: r.organiser,
    maxAmountRequired: r.amountAtomic,
    resource: `/api/agent/buy`,
    description: `WoCo ticket: ${r.eventTitle} — ${r.seriesName}`,
    extra: { eventId, seriesId, name: "USDC", decimals: 6 },
  };
  return Buffer.from(JSON.stringify(body)).toString("base64");
}

// ---------------------------------------------------------------------------
// GET /api/agent/events — discovery. Optional ?organiser=0x… filter.
// ---------------------------------------------------------------------------

agentRouter.get("/events", async (c) => {
  if (rateLimited(clientIp(c))) return c.json({ ok: false, error: "Rate limited" }, 429);
  const organiser = c.req.query("organiser")?.toLowerCase();
  try {
    let entries = await listEvents();
    if (organiser) {
      entries = entries.filter((e) => e.creatorAddress.toLowerCase() === organiser);
    }
    return c.json({ ok: true, data: entries });
  } catch (err) {
    console.error("[agent/events]", err);
    return c.json({ ok: false, error: "Failed to list events" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/agent/events/:eventId — full event detail (series + USDC pricing).
// ---------------------------------------------------------------------------

agentRouter.get("/events/:eventId", async (c) => {
  if (rateLimited(clientIp(c))) return c.json({ ok: false, error: "Rate limited" }, 429);
  try {
    const event = await getEvent(c.req.param("eventId"));
    if (!event) return c.json({ ok: false, error: "Event not found" }, 404);
    // Surface only what an agent needs to choose + price a purchase.
    const series = event.series.map((s) => ({
      seriesId: s.seriesId,
      name: s.name,
      description: s.description,
      totalSupply: s.totalSupply,
      payment: s.payment
        ? {
            price: s.payment.price,
            currency: s.payment.currency,
            cryptoEnabled: s.payment.cryptoEnabled,
            escrow: s.payment.escrow,
            acceptedChains: s.payment.acceptedChains,
          }
        : null,
    }));
    return c.json({
      ok: true,
      data: {
        eventId: event.eventId,
        title: event.title,
        description: event.description,
        startDate: event.startDate,
        location: event.location,
        organiser: event.creatorAddress,
        series,
      },
    });
  } catch (err) {
    console.error("[agent/events/:id]", err);
    return c.json({ ok: false, error: "Failed to load event" }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/agent/grant-params — server-dictated bounds the user's client embeds
// into the spend-permission approval it grants to the agent's address.
// Body: { agentAddress, eventId }  (recipient resolved from the event organiser)
// ---------------------------------------------------------------------------

agentRouter.post("/grant-params", async (c) => {
  if (rateLimited(clientIp(c))) return c.json({ ok: false, error: "Rate limited" }, 429);
  try {
    const { agentAddress, eventId } = (await c.req.json()) as {
      agentAddress?: string;
      eventId?: string;
    };
    if (!agentAddress || !/^0x[0-9a-fA-F]{40}$/.test(agentAddress)) {
      return c.json({ ok: false, error: "Valid agentAddress is required" }, 400);
    }
    if (!eventId) return c.json({ ok: false, error: "eventId is required" }, 400);

    const event = await getEvent(eventId);
    if (!event) return c.json({ ok: false, error: "Event not found" }, 404);
    // Organiser recipient = the crypto recipient on the event's first crypto series.
    const series = event.series.find((s) => s.payment?.cryptoEnabled && !s.payment.escrow);
    if (!series?.payment) {
      return c.json({ ok: false, error: "Event has no direct-transfer crypto series" }, 400);
    }
    const params = agentBudgetParams(
      agentAddress.toLowerCase() as Hex0x,
      series.payment.recipientAddress,
    );
    return c.json({ ok: true, data: params });
  } catch (err) {
    console.error("[agent/grant-params]", err);
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/agent/quote — the exact USDC amount + organiser recipient for a
// series. Read-only planning aid; the authoritative figure is recomputed at /buy.
// Body: { eventId, seriesId }
// ---------------------------------------------------------------------------

agentRouter.post("/quote", async (c) => {
  if (rateLimited(clientIp(c))) return c.json({ ok: false, error: "Rate limited" }, 429);
  try {
    const { eventId, seriesId } = (await c.req.json()) as { eventId?: string; seriesId?: string };
    if (!eventId || !seriesId) {
      return c.json({ ok: false, error: "eventId and seriesId are required" }, 400);
    }
    const resolved = await resolveSeriesPayment(eventId, seriesId);
    if (!resolved.ok) return c.json({ ok: false, error: resolved.error }, resolved.code);
    const r = resolved.data;
    // Issue a one-time purchase intent — the agent echoes intentId back at /buy,
    // binding the draw to THIS purchase (and the issuedAt freshness floor stops a
    // pre-existing matching transfer from being replayed).
    const intent = issuePurchaseIntent({
      eventId,
      seriesId,
      amountAtomic: r.amountAtomic,
      organiser: r.organiser,
    });
    return c.json(
      {
        ok: true,
        data: {
          eventId,
          seriesId,
          chainId: r.chainId,
          usdcAddress: r.usdcAddress,
          recipient: r.organiser,
          amountAtomic: r.amountAtomic,
          fiatPrice: r.fiatPrice,
          currency: r.currency,
          seriesName: r.seriesName,
          eventTitle: r.eventTitle,
          intentId: intent.intentId,
        },
      },
      200,
      { "PAYMENT-REQUIRED": paymentRequiredHeader(r, eventId, seriesId) },
    );
  } catch (err) {
    console.error("[agent/quote]", err);
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/agent/buy — settle a purchase.
//
// Without settlementTxHash  → 402 + PAYMENT-REQUIRED (pay then retry).
// With settlementTxHash      → verify the agent's on-chain draw + mint the ticket
//                              to the funding Kernel.
// Body: { eventId, seriesId, userKernel, settlementTxHash?, encryptedOrder? }
// ---------------------------------------------------------------------------

agentRouter.post("/buy", async (c) => {
  if (rateLimited(clientIp(c))) return c.json({ ok: false, error: "Rate limited" }, 429);
  try {
    const body = (await c.req.json()) as {
      eventId?: string;
      seriesId?: string;
      userKernel?: string;
      settlementTxHash?: string;
      intentId?: string;
      encryptedOrder?: SealedBox;
    };
    const { eventId, seriesId, userKernel, settlementTxHash, intentId, encryptedOrder } = body;
    if (!eventId || !seriesId) {
      return c.json({ ok: false, error: "eventId and seriesId are required" }, 400);
    }

    const resolved = await resolveSeriesPayment(eventId, seriesId);
    if (!resolved.ok) return c.json({ ok: false, error: resolved.error }, resolved.code);
    const r = resolved.data;

    // x402 handshake: no payment yet → 402 + a fresh intent to pay against.
    if (!settlementTxHash) {
      const intent = issuePurchaseIntent({
        eventId,
        seriesId,
        amountAtomic: r.amountAtomic,
        organiser: r.organiser,
      });
      return c.json(
        {
          ok: false,
          error: "Payment required",
          x402: true,
          scheme: "spend-permission",
          intentId: intent.intentId,
        },
        402,
        { "PAYMENT-REQUIRED": paymentRequiredHeader(r, eventId, seriesId) },
      );
    }

    if (!userKernel || !/^0x[0-9a-fA-F]{40}$/.test(userKernel)) {
      return c.json({ ok: false, error: "Valid userKernel is required to settle" }, 400);
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(settlementTxHash)) {
      return c.json({ ok: false, error: "Invalid settlementTxHash" }, 400);
    }
    if (!intentId) {
      return c.json({ ok: false, error: "intentId is required — request a quote first" }, 400);
    }

    // POD gate — fail closed BEFORE consuming the intent / minting, same as the
    // events claim route. A gated-out Kernel can never settle here.
    const gateErr = await gateRejection(r.gate, seriesId, userKernel.toLowerCase() as Hex0x);
    if (gateErr) return c.json({ ok: false, gated: true, error: gateErr }, 403);

    // Bind the draw to this exact purchase. Peek (don't burn yet) to get the
    // freshness floor; the intent is deleted only after a successful settle so a
    // slow-confirming draw can be retried against the same intent.
    const intent = peekPurchaseIntent(intentId, {
      eventId,
      seriesId,
      amountAtomic: r.amountAtomic,
      organiser: r.organiser,
    });
    if (!intent.ok) return c.json({ ok: false, error: intent.error }, 409);

    const result = await settleAgentTicketPurchase({
      chainId: r.chainId,
      settlementTxHash,
      userKernel: userKernel.toLowerCase() as Hex0x,
      organiser: r.organiser,
      usdcAddress: r.usdcAddress,
      amountAtomic: r.amountAtomic,
      eventId,
      seriesId,
      notBeforeUnix: intent.issuedAt,
      encryptedOrder,
    });
    if (!result.ok) return c.json({ ok: false, error: result.error }, result.code);
    deletePurchaseIntent(intentId);

    return c.json({
      ok: true,
      data: {
        ticket: result.ticket,
        settlementTxHash: result.settlementTxHash,
        amountAtomic: r.amountAtomic,
        recipient: r.organiser,
      },
    });
  } catch (err) {
    console.error("[agent/buy]", err);
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Buy failed" }, 500);
  }
});
