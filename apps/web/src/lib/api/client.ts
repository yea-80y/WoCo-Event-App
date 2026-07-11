import type { ApiResponse, SessionDelegation } from "@woco/shared";
import { auth } from "../auth/auth-store.svelte.js";

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
    return JSON.parse(text) as ApiResponse<T>;
  } catch {
    return {
      ok: false,
      error: `HTTP ${resp.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
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

/**
 * Authenticated POST request.
 * Session proof rides in headers — body is untouched.
 */
export async function authPost<T>(
  path: string,
  body: Record<string, unknown>,
  baseUrl?: string,
): Promise<ApiResponse<T>> {
  const bodyText = JSON.stringify(body);
  const authHeaders = await buildAuthHeaders("POST", path, bodyText);

  const resp = await fetch(`${baseUrl ?? BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: bodyText,
  });

  return safeJson<T>(resp);
}

/** Authenticated GET request. */
export async function authGet<T>(path: string, baseUrl?: string): Promise<ApiResponse<T>> {
  const authHeaders = await buildAuthHeaders("GET", path, "");

  const resp = await fetch(`${baseUrl ?? BASE}${path}`, {
    headers: authHeaders,
  });

  const json = await safeJson<T>(resp);
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
  const bodyText = JSON.stringify(body);
  const authHeaders = await buildAuthHeaders("PATCH", path, bodyText);
  const resp = await fetch(`${baseUrl ?? BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: bodyText,
  });
  return safeJson<T>(resp);
}

/** Authenticated PUT request. */
export async function authPut<T>(
  path: string,
  body: Record<string, unknown>,
  baseUrl?: string,
): Promise<ApiResponse<T>> {
  const bodyText = JSON.stringify(body);
  const authHeaders = await buildAuthHeaders("PUT", path, bodyText);
  const resp = await fetch(`${baseUrl ?? BASE}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: bodyText,
  });
  return safeJson<T>(resp);
}

/** Authenticated DELETE request. */
export async function authDelete<T>(path: string, baseUrl?: string): Promise<ApiResponse<T>> {
  const authHeaders = await buildAuthHeaders("DELETE", path, "");

  const resp = await fetch(`${baseUrl ?? BASE}${path}`, {
    method: "DELETE",
    headers: authHeaders,
  });

  return safeJson<T>(resp);
}

/** Exported so callers that need to build a custom fetch (streaming, etc.) can reuse the same auth flow. */
export { buildAuthHeaders };

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
