import type { ApiResponse, SessionDelegation } from "@woco/shared";
import { auth } from "../auth/auth-store.svelte.js";

// Runtime config injected by the site-builder deploy endpoint (takes priority over build-time env vars).
// Absent in the main WoCo app build — only present in standalone event sites deployed via the wizard.
declare global {
  interface Window {
    SITE_CONFIG?: {
      apiUrl?: string;
      gatewayUrl?: string;
      eventId?: string;
      paraApiKey?: string;
    };
  }
}

/** API base URL — runtime config wins, then build-time env var, then empty (dev proxy) */
const BASE =
  (typeof window !== "undefined" && window.SITE_CONFIG?.apiUrl) ||
  import.meta.env.VITE_API_URL ||
  "";

/** Exported for direct fetch calls in events.ts */
export const apiBase = BASE;

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

  return resp.json();
}

/** Authenticated GET request. */
export async function authGet<T>(path: string, baseUrl?: string): Promise<ApiResponse<T>> {
  const authHeaders = await buildAuthHeaders("GET", path, "");

  const resp = await fetch(`${baseUrl ?? BASE}${path}`, {
    headers: authHeaders,
  });

  const json = await resp.json() as ApiResponse<T>;
  if (!json.ok) {
    console.warn(`[authGet] ${path} failed:`, json.error);
  }
  return json;
}

/** Exported so callers that need to build a custom fetch (streaming, etc.) can reuse the same auth flow. */
export { buildAuthHeaders };

/** Unauthenticated GET request. */
export async function get<T>(path: string, baseUrl?: string): Promise<ApiResponse<T>> {
  const resp = await fetch(`${baseUrl ?? BASE}${path}`);
  return resp.json();
}
