/**
 * How a ticket checkout request is sent. Paying by card never opens a wallet:
 * the request is signed only when the caller has decided the purchase links to
 * the account, which ClaimButton does from `auth.isAuthenticated` (a session
 * key already on this device). Signing without one would mint a session first,
 * and for a wallet login that is a signature popup in place of Stripe.
 *
 * Unsigned is the server's guest path: it needs the buyer's email and binds no
 * address. Kept free of the auth store so the choice can be tested directly.
 */

export interface CheckoutResponse {
  ok: boolean;
  url?: string;
  error?: string;
  gated?: boolean;
  /** "ORDER_KEY_STALE" (#186): the box was sealed to a key the organiser moved on from. */
  code?: string;
  /** With ORDER_KEY_STALE: the key to re-seal to. */
  encryptionKeyRef?: string;
}

export interface CheckoutIo {
  authPost(path: string, body: Record<string, unknown>): Promise<unknown>;
  fetch(input: string, init: RequestInit): Promise<{ json(): Promise<unknown> }>;
  apiBase: string;
}

export async function sendCheckout(
  path: string,
  body: Record<string, unknown>,
  linkAccount: boolean,
  io: CheckoutIo,
): Promise<CheckoutResponse> {
  if (linkAccount) return (await io.authPost(path, body)) as CheckoutResponse;
  const resp = await io.fetch(`${io.apiBase}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await resp.json()) as CheckoutResponse;
}
