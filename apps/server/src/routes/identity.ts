import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { getFeedSigner, setFeedSigner } from "../lib/identity/registry.js";

/**
 * Identity registry routes (Phase B — CLIENT_FEED_SIGNER_HANDOVER.md Task 2).
 * The discovery layer that maps a verified parent address → the public address of
 * the content-feed signing key the user owns. See lib/identity/registry.ts.
 */
export const identityRoutes = new Hono<AppEnv>();

/**
 * POST /api/identity/feed-signer — bind the caller's content-feed-signer address
 * to their VERIFIED parent. Auth-gated; the parent is taken from the verified
 * session, never the body. Idempotent (overwrite-in-place).
 */
identityRoutes.post("/feed-signer", requireAuth, async (c) => {
  const parent = c.get("parentAddress");
  const body = c.get("body") as { feedSignerAddress?: unknown };
  if (typeof body.feedSignerAddress !== "string") {
    return c.json({ ok: false, error: "Missing feedSignerAddress" }, 400);
  }
  try {
    const pointer = await setFeedSigner(parent, body.feedSignerAddress);
    return c.json({ ok: true, data: pointer });
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 400) return c.json({ ok: false, error: (err as Error).message }, 400);
    console.error("[identity] feed-signer register failed:", err);
    return c.json({ ok: false, error: "Failed to register feed signer" }, 502);
  }
});

/**
 * GET /api/identity/:address/feed-signer — resolve a user's content-feed-signer
 * address. UNAUTHENTICATED: the pointer is public (just an address) and readers
 * need it before any session exists. Returns null data when unregistered.
 */
identityRoutes.get("/:address/feed-signer", async (c) => {
  const address = c.req.param("address");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return c.json({ ok: false, error: "Invalid address" }, 400);
  }
  const feedSignerAddress = await getFeedSigner(address);
  return c.json({ ok: true, data: { feedSignerAddress } });
});
