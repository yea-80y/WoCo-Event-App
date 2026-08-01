import type { Context, Next } from "hono";
import { verifyMessage } from "ethers";
import { createHash } from "node:crypto";
import { AuthErrorCode } from "@woco/shared";
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

// ---------------------------------------------------------------------------
// Per-request nonce replay protection
// ---------------------------------------------------------------------------
//
// The canonical challenge sig binds a request to method+path+body+ts+nonce.
// Without replay tracking, an attacker who captured a signed request (would
// require breaking TLS — non-trivial but not impossible on hostile networks)
// could replay it within MAX_TIMESTAMP_SKEW_MS and re-execute the same
// operation. Application-level idempotency guards (tx-hash dedup, Stripe
// session dedup, slot reservations) cover most mutating endpoints, but not
// all — e.g. POST /api/sites would re-publish stale site config on replay.
//
// We keep an in-memory Set keyed by (sessionAddress, nonce) with a TTL equal
// to the timestamp-skew window. The set is bounded — at high throughput it
// holds ~one entry per request for 5 min, then is GC'd. A server restart
// loses the set, giving an attacker a worst-case 5-min replay window after
// any restart; acceptable trade-off vs. paying file I/O on the hot path.
//
// Key includes sessionAddress so two different sessions can independently
// use the (astronomically unlikely) same nonce. Nonces are UUIDv4 — 122 bits
// of entropy — so accidental collision is not a concern, only intentional
// replay.

interface SeenNonce {
  timestamp: number; // ts the request was signed with (not when seen)
}
const _seenNonces = new Map<string, SeenNonce>();

/** Strip expired entries. Called opportunistically — bounded sweep per request. */
function gcSeenNonces(now: number): void {
  const cutoff = now - MAX_TIMESTAMP_SKEW_MS;
  // One-pass cleanup. Map iteration is insertion-ordered, but timestamps
  // aren't strictly monotonic across clients, so we sweep the whole map
  // when its size exceeds a threshold. Bounded work — even at 1k req/s
  // the map stays under 300k entries before GC.
  if (_seenNonces.size < 256) return;
  for (const [key, entry] of _seenNonces) {
    if (entry.timestamp < cutoff) _seenNonces.delete(key);
  }
}

/** Returns true if (sessionAddress, nonce) was already seen within the window. */
function markNonceOrReject(
  sessionAddress: string,
  nonce: string,
  timestamp: number,
): boolean {
  const key = `${sessionAddress.toLowerCase()}:${nonce}`;
  const existing = _seenNonces.get(key);
  if (existing) return true; // replay
  _seenNonces.set(key, { timestamp });
  gcSeenNonces(Date.now());
  return false;
}

/**
 * Log an auth rejection and build the response envelope.
 *
 * Every 401/403 out of this middleware used to return silently, which made a
 * user report of "it says the signature is invalid" impossible to diagnose
 * after the fact — the four distinct rejection reasons are indistinguishable
 * from the outside and nothing recorded which one fired. One line per
 * rejection, with enough context (reason, route, session address) to tell them
 * apart in production logs, and never any signature or delegation material.
 */
/**
 * Make an untrusted value safe to put in a log line.
 *
 * The session address header and the host/session fields echoed into reason
 * strings are all caller-controlled and unvalidated — a newline or an ANSI
 * escape in them would let an attacker forge convincing `[auth]` lines in the
 * very log we added to diagnose attacks. Collapse control characters and cap
 * the length; these fields are addresses and hostnames, never prose.
 */
function safeForLog(value: string, max = 120): string {
  const flattened = value.replace(/[\p{Cc}\p{Cf}]/gu, " ");
  return flattened.length > max ? `${flattened.slice(0, max)}…` : flattened;
}

function logAuthReject(
  c: Context<AppEnv>,
  reason: string,
  status: number | null,
  code?: AuthErrorCode,
): void {
  const method = c.req.method.toUpperCase();
  // pathname only — the query string is caller-controlled and can carry
  // identifiers we have no business writing to disk. The signed challenge
  // still commits to pathname + search; this is only the log.
  const path = new URL(c.req.url).pathname;
  const session = safeForLog(c.req.header("x-session-address") ?? "<none>", 48);
  console.warn(
    `[auth] reject ${status ?? "soft"} ${method} ${path} session=${session} ` +
      `reason="${safeForLog(reason)}"` +
      (code ? ` code=${code}` : ""),
  );
}

function rejectAuth(
  c: Context<AppEnv>,
  reason: string,
  status: 401 | 403,
  code?: AuthErrorCode,
) {
  logAuthReject(c, reason, status, code);
  return c.json({ ok: false, error: reason, ...(code ? { code } : {}) }, status);
}

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
    return rejectAuth(c, "Missing X-Session-Address header", 401);
  }

  // Delegation — header only (base64 JSON)
  const delegation = extractDelegation(c.req.raw);
  if (!delegation) {
    return rejectAuth(
      c,
      "Missing or invalid X-Session-Delegation",
      401,
      AuthErrorCode.SESSION_INVALID,
    );
  }

  // Mandatory per-request session signature components
  const sessionSig = c.req.header("x-session-sig");
  const sessionNonce = c.req.header("x-session-nonce");
  const sessionTimestamp = c.req.header("x-session-timestamp");

  if (!sessionSig || !sessionNonce || !sessionTimestamp) {
    return rejectAuth(
      c,
      "Missing session signature headers (X-Session-Sig / X-Session-Nonce / X-Session-Timestamp)",
      401,
    );
  }

  // Timestamp freshness check (prevents indefinite replay of captured sigs)
  const tsNum = Number(sessionTimestamp);
  if (!Number.isFinite(tsNum)) {
    return rejectAuth(c, "Invalid X-Session-Timestamp", 401);
  }
  const skew = Math.abs(Date.now() - tsNum);
  if (skew > MAX_TIMESTAMP_SKEW_MS) {
    // Report the measured skew: re-signing cannot fix a wrong device clock, so
    // this number is the whole diagnosis when a user says "it stopped working".
    return rejectAuth(
      c,
      `Session timestamp out of window (device clock is ${Math.round(skew / 1000)}s from server time)`,
      401,
      AuthErrorCode.SESSION_CLOCK_SKEW,
    );
  }

  // Verify the delegation bundle (parent EIP-712 sig, sessionProof, expiry, host, revocation)
  const allowedHosts = getAllowedHosts();
  const result = await verifyDelegation(delegation, sessionAddress, allowedHosts);
  if (!result.valid) {
    // verifyDelegation classifies the rejections a re-mint cannot fix (clock
    // skew); everything else is delegation-level and worth re-minting.
    return rejectAuth(
      c,
      result.error ?? "Invalid delegation",
      403,
      result.code ?? AuthErrorCode.SESSION_INVALID,
    );
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
      return rejectAuth(
        c,
        "Session signature does not match session key",
        403,
        AuthErrorCode.SESSION_INVALID,
      );
    }
  } catch {
    return rejectAuth(c, "Invalid session signature", 403, AuthErrorCode.SESSION_INVALID);
  }

  // Replay protection: only mark the nonce as seen AFTER the signature has
  // verified. Marking earlier would let an unauthenticated attacker grief
  // the map by burning nonces a legitimate client might later present.
  if (markNonceOrReject(result.sessionAddress!, sessionNonce, tsNum)) {
    return rejectAuth(c, "Nonce replay detected", 403, AuthErrorCode.SESSION_REPLAY);
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
export async function tryVerifyAuth(
  c: Context<AppEnv>,
  rawBody: string,
): Promise<
  | { ok: true; parentAddress: string; sessionAddress: string }
  | { ok: false; error: string; code?: AuthErrorCode }
  | null
> {
  /** Log, then shape the failure return. Mirrors requireAuth's rejectAuth —
   *  this variant hands the failure back to the caller instead of responding,
   *  but must be just as visible in the logs: these are the money paths.
   *  Status is `null`, not a number: the CALLER picks it (shops answers 403,
   *  stripe answers 401), so claiming one here would put a lie in the log. */
  const fail = (error: string, code?: AuthErrorCode) => {
    logAuthReject(c, error, null, code);
    return { ok: false as const, error, ...(code ? { code } : {}) };
  };

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
  if (!sessionAddress) return fail("Missing X-Session-Address header");
  if (!sessionSig || !sessionNonce || !sessionTimestamp) {
    return fail("Missing session signature headers");
  }

  const delegation = extractDelegation(c.req.raw);
  if (!delegation) {
    return fail("Missing or invalid X-Session-Delegation", AuthErrorCode.SESSION_INVALID);
  }

  const tsNum = Number(sessionTimestamp);
  if (!Number.isFinite(tsNum)) return fail("Invalid X-Session-Timestamp");
  const skew = Math.abs(Date.now() - tsNum);
  if (skew > MAX_TIMESTAMP_SKEW_MS) {
    return fail(
      `Session timestamp out of window (device clock is ${Math.round(skew / 1000)}s from server time)`,
      AuthErrorCode.SESSION_CLOCK_SKEW,
    );
  }

  const allowedHosts = getAllowedHosts();
  const result = await verifyDelegation(delegation, sessionAddress, allowedHosts);
  if (!result.valid) {
    return fail(result.error ?? "Invalid delegation", result.code ?? AuthErrorCode.SESSION_INVALID);
  }

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
      return fail(
        "Session signature does not match session key",
        AuthErrorCode.SESSION_INVALID,
      );
    }
  } catch {
    return fail("Invalid session signature", AuthErrorCode.SESSION_INVALID);
  }

  if (markNonceOrReject(result.sessionAddress!, sessionNonce, tsNum)) {
    return fail("Nonce replay detected", AuthErrorCode.SESSION_REPLAY);
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
