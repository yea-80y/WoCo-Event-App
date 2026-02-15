import type { Context, Next } from "hono";
import {
  verifyDelegation,
  extractDelegation,
} from "../lib/auth/verify-delegation.js";

/**
 * Hono middleware that verifies session delegation on protected routes.
 *
 * Expects the request to include:
 * - Body field `session` (session key address)
 * - Body field `delegation` (SessionDelegation bundle)
 *   OR header `X-Session-Delegation` (base64-encoded JSON)
 *
 * On success, sets `c.set("parentAddress", ...)` and `c.set("sessionAddress", ...)`
 * for downstream handlers.
 */
export async function requireAuth(c: Context, next: Next) {
  let body: Record<string, unknown> = {};

  // Parse body if present (POST/PUT/PATCH)
  if (["POST", "PUT", "PATCH"].includes(c.req.method)) {
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "Invalid JSON body" }, 400);
    }
  }

  const sessionAddress = (body.session as string) ??
    c.req.header("x-session-address");

  if (!sessionAddress) {
    return c.json({ ok: false, error: "Missing session address" }, 401);
  }

  const delegation = extractDelegation(c.req.raw, body as any);
  if (!delegation) {
    return c.json({ ok: false, error: "Missing session delegation" }, 401);
  }

  const allowedHosts = process.env.ALLOWED_HOSTS?.split(",") ?? undefined;
  const result = verifyDelegation(delegation, sessionAddress, allowedHosts);

  if (!result.valid) {
    return c.json({ ok: false, error: result.error }, 403);
  }

  // Make parent + session available to downstream handlers
  c.set("parentAddress", result.parentAddress!);
  c.set("sessionAddress", result.sessionAddress!);
  c.set("body", body);

  await next();
}
