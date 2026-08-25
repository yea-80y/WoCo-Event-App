import { AuthErrorCode, type ApiResponse, type SessionDelegation } from "@woco/shared";
import { auth } from "../auth/auth-store.svelte.js";
import { sessionHealth } from "./session-health.svelte.js";

/** API base URL — runtime config wins, then build-time env var, then empty (dev proxy) */
const BASE =
  (typeof window !== "undefined" && window.SITE_CONFIG?.apiUrl) ||
  import.meta.env.VITE_API_URL ||
  "";

/** Exported for direct fetch calls in events.ts */
export const apiBase = BASE;

/**
 * The siteId of the deployed organiser site this app is running inside, or
 * undefined when running in the main WoCo app. Sent with claim/reservation
 * requests so the server can resolve the event's content-feed signer from that
 * site's server-written SiteEventsIndex (the trusted money-path carrier) — which
 * lets a client-signed, not-WoCo-listed event resolve. It is only a POINTER;
 * the server derives trust from the index it selects, never from this value.
 */
export function currentSiteId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.SITE_CONFIG?.site?.siteId;
}

/**
 * Read a response body as JSON, falling back to a typed `{ ok: false, error }`
 * envelope when the server returns a non-JSON body (e.g. Hono's plain-text
 * "404 Not Found" or an upstream HTML error page). Without this, callers
 * `await resp.json()` throws SyntaxError unhandled — UI state machines that
 * sit outside try/catch end up frozen instead of surfacing the error.
 */
async function safeJson<T>(resp: Response): Promise<ApiResponse<T>> {
  const text = await resp.text();
  try {
    // `status` is stamped on every response, not just the non-JSON fallback.
    // Without it a 403 auth rejection and a 400 business-rule failure both
    // arrive as `{ ok: false, error }` and no caller can tell them apart.
    return { ...(JSON.parse(text) as ApiResponse<T>), status: resp.status };
  } catch {
    return {
      ok: false,
      error: `HTTP ${resp.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      status: resp.status,
    } as ApiResponse<T>;
  }
}

/**
 * Build the auth headers for an authenticated request.
 *
 * The session key signs a challenge derived from method + path + timestamp +
 * nonce + sha256(body). Delegation, session address, signature, nonce, and
 * timestamp all ride in headers — the request body is never modified.
 */
async function buildAuthHeaders(
  method: string,
  path: string,
  body: string,
): Promise<Record<string, string>> {
  const signed = await auth.signRequest(method, path, body);
  if (!signed) throw new Error("Not authenticated");

  // btoa can't handle non-ASCII in the delegation JSON — use UTF-8 safe encoding
  const delegationJson = JSON.stringify(signed.delegation);
  const delegationB64 = typeof btoa === "function"
    ? btoa(unescape(encodeURIComponent(delegationJson)))
    : Buffer.from(delegationJson, "utf-8").toString("base64");

  return {
    "X-Session-Address": signed.sessionAddress,
    "X-Session-Delegation": delegationB64,
    "X-Session-Sig": signed.signature,
    "X-Session-Nonce": signed.nonce,
    "X-Session-Timestamp": signed.timestamp,
  };
}

// ---------------------------------------------------------------------------
// Session recovery
// ---------------------------------------------------------------------------
//
// The client's local session checks (expiry, host, parent — see
// restoreSession) cannot see server-side truth: revocation, the live on-chain
// Kernel owner, ALLOWED_HOSTS. When those diverge the server answers
// SESSION_INVALID for a delegation the client still believes in, and every
// subsequent request fails the same way. Until this existed the app had no way
// out of that state — the user had to work out for themselves that signing out
// and back in was the fix.
//
// So: on SESSION_INVALID, wipe the delegation, let ensureSession() mint a fresh
// one, and replay the request exactly once.
//
// The generation counter stops a thundering herd from ping-ponging. Several
// requests in flight together will all come back SESSION_INVALID; without it,
// the slowest would reset the session the fastest had just re-established, and
// they would take turns invalidating each other. A request only triggers
// recovery if none has completed since it was sent — otherwise it just retries
// against the session someone else already fixed.

let _recoveryGeneration = 0;
let _recoveryInFlight: Promise<void> | null = null;
let _recoverySuppressedUntil = 0;

/**
 * How long to stop attempting recovery after one provably failed.
 *
 * Not every SESSION_INVALID is fixable by minting a new delegation: a host
 * missing from ALLOWED_HOSTS re-mints under the same `window.location.host`,
 * and a Kernel whose on-chain owner has rotated away will reject every
 * delegation the current key can produce. For those, recovery is a treadmill —
 * one wasted wallet/passkey prompt per user action, forever. Once a recovery
 * has been followed immediately by another SESSION_INVALID, stop trying for a
 * while and let the error surface. Short enough that a genuinely transient
 * server-side cause still heals on its own.
 */
const RECOVERY_SUPPRESSION_MS = 60_000;

async function recoverSession(seenGeneration: number): Promise<void> {
  if (Date.now() < _recoverySuppressedUntil) return; // proven not to help
  if (_recoveryGeneration > seenGeneration) return; // someone already fixed it
  if (_recoveryInFlight) return _recoveryInFlight;
  _recoveryInFlight = (async () => {
    try {
      console.warn("[api] server rejected the session delegation — re-establishing");
      await auth.resetSession();
      _recoveryGeneration++;
    } catch (e) {
      // resetSession is IndexedDB deletes, which CAN fail (private browsing,
      // storage pressure). This promise is shared by every concurrent caller,
      // so letting it reject would reject all of them — the unhandled-rejection
      // failure that safeJson exists to prevent. Swallow: the retry below will
      // simply fail again and return a normal envelope.
      console.warn("[api] session reset failed:", e);
    } finally {
      _recoveryInFlight = null;
    }
  })();
  return _recoveryInFlight;
}

/**
 * Single path for every authenticated verb: sign, send, and recover once from a
 * server-side session rejection.
 *
 * `bodyText === null` means "no request body" (GET/DELETE) — distinct from an
 * empty string, which would still set Content-Type.
 */
async function authFetch<T>(
  method: string,
  path: string,
  bodyText: string | null,
  baseUrl?: string,
): Promise<ApiResponse<T>> {
  const send = async (): Promise<ApiResponse<T>> => {
    const authHeaders = await buildAuthHeaders(method, path, bodyText ?? "");
    const resp = await fetch(`${baseUrl ?? BASE}${path}`, {
      method,
      headers:
        bodyText === null
          ? authHeaders
          : { "Content-Type": "application/json", ...authHeaders },
      ...(bodyText === null ? {} : { body: bodyText }),
    });
    return safeJson<T>(resp);
  };

  const generation = _recoveryGeneration;
  const result = await send();

  if (result.ok) {
    // Any authenticated success proves the session works — the banner must
    // never outlive the condition it reports.
    sessionHealth.clear();
    return result;
  }
  if (result.code !== AuthErrorCode.SESSION_INVALID) {
    // A wrong device clock is NOT fixable by re-signing — re-signing just
    // reproduces the same out-of-window timestamp. Say what is actually wrong
    // instead of letting "invalid signature" take the blame.
    if (result.code === AuthErrorCode.SESSION_CLOCK_SKEW) {
      return {
        ...result,
        error:
          "Your device's clock is out of sync with the server, so the request was rejected. " +
          "Turn on automatic date & time in your device settings, then try again.",
      };
    }
    return result;
  }

  await recoverSession(generation);

  // Second and final attempt. Two very different things can throw here and they
  // must not be conflated:
  //
  //  - buildAuthHeaders throws "Not authenticated" when the session could not be
  //    re-established (ensureSession returned false — usually the user dismissed
  //    the signing prompt). "Please sign in again" is the right answer.
  //  - fetch throws a TypeError when the network is gone. Telling that user
  //    their session expired is a wrong diagnosis that pushes them into a
  //    needless re-login; surface the transport failure instead.
  try {
    const retried = await send();
    if (retried.ok) {
      sessionHealth.clear();
      return retried;
    }
    if (retried.code === AuthErrorCode.SESSION_INVALID) {
      // A fresh delegation was just rejected the same way — re-minting is not
      // the cure here. Stop burning signing prompts on it, and raise the one
      // app-wide fact the screens can't each discover: reads are now
      // unverifiable, not empty (#256). This is the ONLY writer of that flag,
      // so it always means "proven", never "a request failed".
      _recoverySuppressedUntil = Date.now() + RECOVERY_SUPPRESSION_MS;
      sessionHealth.markEnded();
      console.warn(
        "[api] a freshly-minted session was rejected too — pausing recovery; " +
          "check ALLOWED_HOSTS and the account's on-chain owner",
      );
    }
    return retried;
  } catch (e) {
    const notAuthenticated = e instanceof Error && e.message === "Not authenticated";
    return {
      ok: false,
      error: notAuthenticated
        ? "Your session has expired. Please sign in again to continue."
        : "Could not reach the server. Check your connection and try again.",
      ...(notAuthenticated ? { code: AuthErrorCode.SESSION_INVALID, status: 403 } : {}),
    } as ApiResponse<T>;
  }
}

/**
 * Authenticated POST request.
 * Session proof rides in headers — body is untouched.
 */
export async function authPost<T>(
  path: string,
  body: Record<string, unknown>,
  baseUrl?: string,
): Promise<ApiResponse<T>> {
  return authFetch<T>("POST", path, JSON.stringify(body), baseUrl);
}

/** Authenticated GET request. */
export async function authGet<T>(path: string, baseUrl?: string): Promise<ApiResponse<T>> {
  const json = await authFetch<T>("GET", path, null, baseUrl);
  if (!json.ok) {
    console.warn(`[authGet] ${path} failed:`, json.error);
  }
  return json;
}

/** Authenticated PATCH request. */
export async function authPatch<T>(
  path: string,
  body: Record<string, unknown>,
  baseUrl?: string,
): Promise<ApiResponse<T>> {
  return authFetch<T>("PATCH", path, JSON.stringify(body), baseUrl);
}

/** Authenticated PUT request. */
export async function authPut<T>(
  path: string,
  body: Record<string, unknown>,
  baseUrl?: string,
): Promise<ApiResponse<T>> {
  return authFetch<T>("PUT", path, JSON.stringify(body), baseUrl);
}

/** Authenticated DELETE request. */
export async function authDelete<T>(path: string, baseUrl?: string): Promise<ApiResponse<T>> {
  return authFetch<T>("DELETE", path, null, baseUrl);
}

/**
 * Authenticated request whose RESPONSE BODY the caller reads itself — the
 * streaming case, where `authFetch` cannot help because it consumes the body as
 * JSON.
 *
 * Exists so `buildAuthHeaders` does not have to be exported. A hand-rolled
 * caller keeps the pre-#107 behaviour: the server rejects the delegation, the
 * caller surfaces a raw error, and the user stays wedged until they manually
 * sign out and back in — the exact failure one-shot recovery was added to
 * remove (#108). An invariant with one permitted exception is one nobody can
 * check, so there is now no exception: this module is the only place auth
 * headers are built, enforced by the module system rather than by a rule.
 *
 * Replaying a rejected request is safe: `requireAuth` rejects BEFORE the route
 * handler runs, so a rejected publish has no side effects to replay
 * (`apps/server/test/auth-rejection-codes.test.ts` pins that).
 *
 * `bodyText === null` means "no request body" — distinct from an empty string,
 * which would still set Content-Type.
 */
export async function authStream(
  method: string,
  path: string,
  bodyText: string | null,
  baseUrl?: string,
): Promise<Response> {
  const send = async (): Promise<Response> => {
    const authHeaders = await buildAuthHeaders(method, path, bodyText ?? "");
    return fetch(`${baseUrl ?? BASE}${path}`, {
      method,
      headers:
        bodyText === null
          ? authHeaders
          : { "Content-Type": "application/json", ...authHeaders },
      ...(bodyText === null ? {} : { body: bodyText }),
    });
  };

  const generation = _recoveryGeneration;
  const resp = await send();
  if (resp.ok) {
    sessionHealth.clear();
    return resp;
  }

  // Peek at the error through a CLONE: the caller still owns the original body
  // and reads it for its own error message when we hand this response back.
  const body = await resp
    .clone()
    .json()
    .catch(() => null) as { code?: string } | null;
  if (body?.code !== AuthErrorCode.SESSION_INVALID) return resp;

  await recoverSession(generation);

  const retried = await send();
  if (retried.ok) {
    sessionHealth.clear();
    return retried;
  }
  const retriedBody = await retried
    .clone()
    .json()
    .catch(() => null) as { code?: string } | null;
  if (retriedBody?.code === AuthErrorCode.SESSION_INVALID) {
    // Same reasoning as authFetch: a freshly-minted delegation rejected the
    // same way is not curable by minting another.
    _recoverySuppressedUntil = Date.now() + RECOVERY_SUPPRESSION_MS;
    sessionHealth.markEnded();
    console.warn(
      "[api] a freshly-minted session was rejected too — pausing recovery; " +
        "check ALLOWED_HOSTS and the account's on-chain owner",
    );
  }
  return retried;
}

/** Unauthenticated GET request. */
export async function get<T>(path: string, baseUrl?: string): Promise<ApiResponse<T>> {
  const resp = await fetch(`${baseUrl ?? BASE}${path}`);
  return safeJson<T>(resp);
}

/** Unauthenticated POST request. */
export async function post<T>(path: string, body: unknown, baseUrl?: string): Promise<ApiResponse<T>> {
  const resp = await fetch(`${baseUrl ?? BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return safeJson<T>(resp);
}
