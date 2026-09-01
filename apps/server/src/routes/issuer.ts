/**
 * /api/issuer — the issuer-registry relay (issuer-curve migration PR 5b).
 *
 * POST /statement is session-authenticated and owner-scoped: the relay refuses
 * a statement whose `parent` is not the verified session parent, so the record
 * is unwritable by anyone but its owner (the #433 lesson). Everything
 * cryptographic — the parent's EIP-712 signature, the issuing key's proof of
 * possession, the rotation co-signature, the generation chain — is verified in
 * `lib/issuer/registry.ts` + `@woco/shared`'s `verifyIssuerStatement`, and any
 * client re-verifies the published log with zero server trust.
 *
 * GET /:parent is public: the registry exists to be read.
 */

import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { relayIssuerStatement, getIssuerRegistry } from "../lib/issuer/registry.js";

export const issuerRouter = new Hono<AppEnv>();

issuerRouter.post("/statement", requireAuth, async (c) => {
  const parentAddress = c.get("parentAddress") as string;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const statement = (body as { statement?: unknown })?.statement ?? body;
  const result = await relayIssuerStatement(parentAddress, statement);
  if (!result.ok) return c.json(result, 400);
  // `published: false` = recorded durably but the feed write failed; the
  // client retries the SAME statement and the relay republishes idempotently.
  return c.json({ ok: true, data: { gen: result.gen, published: result.published } });
});

issuerRouter.get("/:parent", async (c) => {
  const parent = c.req.param("parent");
  if (!/^0x[0-9a-fA-F]{40}$/.test(parent)) {
    return c.json({ ok: false, error: "parent must be a 0x-prefixed 20-byte address" }, 400);
  }
  return c.json({ ok: true, data: getIssuerRegistry(parent) });
});
