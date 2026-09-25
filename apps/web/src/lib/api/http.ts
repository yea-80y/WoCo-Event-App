/**
 * The unauthenticated half of the API client: base URL, response parsing, and
 * plain GET/POST. No auth store import, deliberately - the read path (SOC probes,
 * public reads) needs none of it, and keeping it out lets that path load under
 * the node test runner (#658). `client.ts` re-exports everything here.
 */

import type { ApiResponse } from "@woco/shared";

/**
 * The build-time API URL. Written as the EXACT expression Vite replaces with the
 * one value: `import.meta.env?.VITE_API_URL` would make it inline the whole env
 * object instead - every VITE_ setting - into bundles that organiser sites
 * publish to Swarm for good. The try covers the node test runner, which has no
 * `import.meta.env`.
 */
function buildTimeApiUrl(): string | undefined {
  try {
    return import.meta.env.VITE_API_URL;
  } catch {
    return undefined;
  }
}

/** API base URL — runtime config wins, then build-time env var, then empty (dev proxy) */
export const BASE: string =
  (typeof window !== "undefined" && window.SITE_CONFIG?.apiUrl) ||
  buildTimeApiUrl() ||
  "";

/** Exported for direct fetch calls in events.ts */
export const apiBase = BASE;

/**
 * Read a response body as JSON, falling back to a typed `{ ok: false, error }`
 * envelope when the server returns a non-JSON body (e.g. Hono's plain-text
 * "404 Not Found" or an upstream HTML error page). Without this, callers
 * `await resp.json()` throws SyntaxError unhandled — UI state machines that
 * sit outside try/catch end up frozen instead of surfacing the error.
 */
export async function safeJson<T>(resp: Response): Promise<ApiResponse<T>> {
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
