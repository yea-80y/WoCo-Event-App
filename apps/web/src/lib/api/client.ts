import type { ApiResponse, SessionDelegation } from "@woco/shared";
import { auth } from "../auth/auth-store.svelte.js";

/** API base URL — empty in dev (Vite proxy), full URL in production */
const BASE = import.meta.env.VITE_API_URL || "";

/** Exported for direct fetch calls in events.ts */
export const apiBase = BASE;

/**
 * Authenticated POST request.
 * Attaches session address + delegation to the body.
 */
export async function authPost<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<ApiResponse<T>> {
  const signed = await auth.signRequest(JSON.stringify(body));
  if (!signed) throw new Error("Not authenticated");

  const resp = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...body,
      session: signed.sessionAddress,
      delegation: signed.delegation,
    }),
  });

  return resp.json();
}

/** Authenticated GET request (delegation via headers). */
export async function authGet<T>(path: string): Promise<ApiResponse<T>> {
  const signed = await auth.signRequest("");
  if (!signed) throw new Error("Not authenticated");

  const delegationB64 = btoa(JSON.stringify(signed.delegation));

  const resp = await fetch(`${BASE}${path}`, {
    headers: {
      "X-Session-Address": signed.sessionAddress,
      "X-Session-Delegation": delegationB64,
    },
  });

  return resp.json();
}

/** Unauthenticated GET request. */
export async function get<T>(path: string): Promise<ApiResponse<T>> {
  const resp = await fetch(`${BASE}${path}`);
  return resp.json();
}
