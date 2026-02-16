import { Hono } from "hono";
import type { Hex0x } from "@woco/shared";
import type { AppEnv } from "../types.js";
import { claimTicket, hashEmail, getClaimStatus, type ClaimIdentifier } from "../lib/event/claim-service.js";

const claims = new Hono<AppEnv>();

// POST /api/events/:eventId/series/:seriesId/claim - claim a ticket (no auth required)
claims.post("/:eventId/series/:seriesId/claim", async (c) => {
  const seriesId = c.req.param("seriesId");

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const mode = (body.mode as string) || "wallet";

  let identifier: ClaimIdentifier;

  if (mode === "wallet") {
    // Accept walletAddress (new) or claimerAddress (legacy)
    const address = (body.walletAddress as string) || (body.claimerAddress as string);
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return c.json({ ok: false, error: "Invalid wallet address" }, 400);
    }
    identifier = { type: "wallet", address: address.toLowerCase() as Hex0x };

  } else if (mode === "email") {
    const email = body.email as string;
    if (!email || !email.includes("@")) {
      return c.json({ ok: false, error: "Invalid email" }, 400);
    }
    identifier = { type: "email", email, emailHash: hashEmail(email) };

  } else if (mode === "api") {
    const apiKey = body.apiKey as string;
    const expected = process.env.ORGANIZER_API_KEY;
    if (!expected || apiKey !== expected) {
      return c.json({ ok: false, error: "Invalid API key" }, 403);
    }
    // API mode uses wallet address or email passed by organizer
    const address = body.walletAddress as string;
    const email = body.email as string;
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
    const ticket = await claimTicket({ seriesId, identifier });
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
