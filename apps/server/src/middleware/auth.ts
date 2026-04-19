import type { Context, Next } from "hono";
import { verifyMessage } from "ethers";
import { createHash } from "node:crypto";
import type { AppEnv } from "../types.js";
import {
  verifyDelegation,
  extractDelegation,
} from "../lib/auth/verify-delegation.js";

/**
 * Hono middleware that verifies session delegation on protected routes.
 *
 * Auth format (v2 — canonical challenge, 2026-04-09):
 *
 *   X-Session-Address:    session key address
 *   X-Session-Delegation: base64(JSON(SessionDelegation))
 *   X-Session-Sig:        EIP-191 signature over canonical challenge
 *   X-Session-Nonce:      unique per-request nonce (UUID)
 *   X-Session-Timestamp:  client-generated unix ms timestamp
 *
 * Canonical challenge (what the session key signs):
 *
 *   "woco-session-v1\n{METHOD}\n{path}\n{timestamp}\n{nonce}\n{sha256(body)}"
 *
 * The server reads the raw body text once (via c.req.text()), hashes it,
 * rebuilds the challenge, and verifies the signature. No JSON parse/re-stringify
 * round trip — the body bytes the client signed are the body bytes the server
 * verifies.
 *
 * The parsed body is exposed downstream via c.get("body") so route handlers
 * don't need to touch the raw text.
 */

/** Max clock skew between client and server (5 minutes). */
const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

export async function requireAuth(c: Context<AppEnv>, next: Next) {
  const method = c.req.method.toUpperCase();
  const path = new URL(c.req.url).pathname + new URL(c.req.url).search;

  // Read raw body exactly once. For GET/HEAD there is no body.
  const hasBody = method !== "GET" && method !== "HEAD";
  let rawBody = "";
  let body: Record<string, unknown> = {};

  if (hasBody) {
    try {
      rawBody = await c.req.text();
      body = rawBody.length > 0 ? JSON.parse(rawBody) : {};
    } catch {
      return c.json({ ok: false, error: "Invalid JSON body" }, 400);
    }
  }

  // Session address — header only (body-based session field is no longer honoured)
  const sessionAddress = c.req.header("x-session-address");
  if (!sessionAddress) {
    return c.json({ ok: false, error: "Missing X-Session-Address header" }, 401);
  }

  // Delegation — header only (base64 JSON)
  const delegation = extractDelegation(c.req.raw);
  if (!delegation) {
    return c.json({ ok: false, error: "Missing or invalid X-Session-Delegation" }, 401);
  }

  // Mandatory per-request session signature components
  const sessionSig = c.req.header("x-session-sig");
  const sessionNonce = c.req.header("x-session-nonce");
  const sessionTimestamp = c.req.header("x-session-timestamp");

  if (!sessionSig || !sessionNonce || !sessionTimestamp) {
    return c.json(
      { ok: false, error: "Missing session signature headers (X-Session-Sig / X-Session-Nonce / X-Session-Timestamp)" },
      401,
    );
  }

  // Timestamp freshness check (prevents indefinite replay of captured sigs)
  const tsNum = Number(sessionTimestamp);
  if (!Number.isFinite(tsNum)) {
    return c.json({ ok: false, error: "Invalid X-Session-Timestamp" }, 401);
  }
  const skew = Math.abs(Date.now() - tsNum);
  if (skew > MAX_TIMESTAMP_SKEW_MS) {
    return c.json({ ok: false, error: "Session timestamp out of window" }, 401);
  }

  // Verify the delegation bundle (parent EIP-712 sig, sessionProof, expiry, host, revocation)
  const allowedHosts = getAllowedHosts();
  const result = verifyDelegation(delegation, sessionAddress, allowedHosts);
  if (!result.valid) {
    return c.json({ ok: false, error: result.error }, 403);
  }

  // Rebuild the canonical challenge and verify the per-request signature.
  // The hash is over the *exact* bytes of the request body — no parse/re-stringify.
  const bodyHash = sha256Hex(rawBody);
  const challenge = [
    "woco-session-v1",
    method,
    path,
    sessionTimestamp,
    sessionNonce,
    bodyHash,
  ].join("\n");

  try {
    const signerAddress = verifyMessage(challenge, sessionSig);
    if (signerAddress.toLowerCase() !== result.sessionAddress!.toLowerCase()) {
      return c.json({ ok: false, error: "Session signature does not match session key" }, 403);
    }
  } catch {
    return c.json({ ok: false, error: "Invalid session signature" }, 403);
  }

  // Make parent + session + parsed body available to downstream handlers
  c.set("parentAddress", result.parentAddress!);
  c.set("sessionAddress", result.sessionAddress!);
  c.set("body", body);

  await next();
}

/** SHA-256 hex digest of a UTF-8 string. */
function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * Soft-auth variant of `requireAuth` for endpoints that must support BOTH
 * authenticated and anonymous flows (e.g. Stripe checkout — logged-in users
 * bind the claim to their wallet; email-only users pay anonymously).
 *
 * Returns:
 *   - `{ parentAddress, sessionAddress, bodyInvalid: false }` — auth verified
 *   - `null` — no auth headers present (anonymous path)
 *   - `{ bodyInvalid: true, error }` — auth headers present but invalid; the
 *     caller MUST reject the request (don't silently downgrade — that would
 *     let an attacker pretend to be anonymous after a bad sig).
 *
 * Caller is responsible for reading the raw body via `c.req.text()` once and
 * passing it in — we must hash the exact bytes the client signed.
 */
export function tryVerifyAuth(
  c: Context<AppEnv>,
  rawBody: string,
):
  | { ok: true; parentAddress: string; sessionAddress: string }
  | { ok: false; error: string }
  | null {
  const sessionAddress = c.req.header("x-session-address");
  const sessionSig = c.req.header("x-session-sig");
  const sessionNonce = c.req.header("x-session-nonce");
  const sessionTimestamp = c.req.header("x-session-timestamp");
  const delegationHeader = c.req.header("x-session-delegation");

  // No auth material at all → anonymous path
  if (!sessionAddress && !sessionSig && !sessionNonce && !sessionTimestamp && !delegationHeader) {
    return null;
  }

  // Partial headers → malformed request, reject
  if (!sessionAddress) return { ok: false, error: "Missing X-Session-Address header" };
  if (!sessionSig || !sessionNonce || !sessionTimestamp) {
    return { ok: false, error: "Missing session signature headers" };
  }

  const delegation = extractDelegation(c.req.raw);
  if (!delegation) return { ok: false, error: "Missing or invalid X-Session-Delegation" };

  const tsNum = Number(sessionTimestamp);
  if (!Number.isFinite(tsNum)) return { ok: false, error: "Invalid X-Session-Timestamp" };
  if (Math.abs(Date.now() - tsNum) > MAX_TIMESTAMP_SKEW_MS) {
    return { ok: false, error: "Session timestamp out of window" };
  }

  const allowedHosts = getAllowedHosts();
  const result = verifyDelegation(delegation, sessionAddress, allowedHosts);
  if (!result.valid) return { ok: false, error: result.error ?? "Invalid delegation" };

  const method = c.req.method.toUpperCase();
  const path = new URL(c.req.url).pathname + new URL(c.req.url).search;
  const bodyHash = sha256Hex(rawBody);
  const challenge = [
    "woco-session-v1",
    method,
    path,
    sessionTimestamp,
    sessionNonce,
    bodyHash,
  ].join("\n");

  try {
    const signerAddress = verifyMessage(challenge, sessionSig);
    if (signerAddress.toLowerCase() !== result.sessionAddress!.toLowerCase()) {
      return { ok: false, error: "Session signature does not match session key" };
    }
  } catch {
    return { ok: false, error: "Invalid session signature" };
  }

  return {
    ok: true,
    parentAddress: result.parentAddress!,
    sessionAddress: result.sessionAddress!,
  };
}

/**
 * Resolve the ALLOWED_HOSTS configuration.
 *
 * In production, the server refuses to start without ALLOWED_HOSTS (see index.ts).
 * In dev, a safe default is applied so local flows Just Work.
 *
 * Returns undefined only if we're in dev and the operator explicitly set ALLOWED_HOSTS="*"
 * (which disables host binding — discouraged but supported for testing).
 */
function getAllowedHosts(): string[] | undefined {
  const raw = process.env.ALLOWED_HOSTS;
  if (!raw) {
    // Dev default — matches localhost:5173 (vite) and localhost:3001 (server)
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "ALLOWED_HOSTS is not set. Refusing to serve authenticated requests without host binding.",
      );
    }
    return ["localhost:5173", "localhost:3001"];
  }
  if (raw.trim() === "*") return undefined; // explicit opt-out
  return raw.split(",").map((h) => h.trim()).filter(Boolean);
}
