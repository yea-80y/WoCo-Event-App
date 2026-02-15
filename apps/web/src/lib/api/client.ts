import type { ApiResponse, SessionDelegation } from "@woco/shared";
import { auth } from "../auth/auth-store.svelte.js";

const BASE = "";  // Uses Vite proxy in dev, relative path in prod

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

/** Unauthenticated GET request. */
export async function get<T>(path: string): Promise<ApiResponse<T>> {
  const resp = await fetch(`${BASE}${path}`);
  return resp.json();
}
