/** 64-char hex string without 0x prefix (Swarm references) */
export type Hex64 = string;

/** Hex string with 0x prefix (Ethereum addresses, hashes) */
export type Hex0x = `0x${string}`;

/** Standard API response envelope */
export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  /** Machine-readable error code (e.g. BATCH_PURCHASE_REQUIRED) — UI branches on
   *  this, never on the human-readable `error` text. */
  code?: string;
  /** HTTP status of the response. Populated client-side by the api client so
   *  callers can distinguish an auth rejection from a business-rule failure —
   *  both arrive as `{ ok: false }` and were previously indistinguishable. */
  status?: number;
}

/**
 * Machine-readable codes for the session-auth layer (`requireAuth`).
 *
 * The client keys its recovery on these, never on the human-readable message —
 * the three cases need materially different responses:
 *
 *  - SESSION_INVALID   the stored delegation is not acceptable to the server
 *                      (bad/expired/revoked signature, host mismatch, session
 *                      key mismatch). Minting a fresh delegation fixes it, so
 *                      the client wipes and re-establishes ONCE, transparently.
 *  - SESSION_CLOCK_SKEW the device clock is more than the skew window away from
 *                      the server's. Re-signing produces an identically-rejected
 *                      request, so the client must NOT retry — it surfaces the
 *                      real cause instead of a misleading "invalid signature".
 *  - SESSION_REPLAY    nonce already seen. Transient and self-correcting on the
 *                      next request; the delegation itself is fine, so there is
 *                      nothing to re-establish.
 */
export const AuthErrorCode = {
  SESSION_INVALID: "SESSION_INVALID",
  SESSION_CLOCK_SKEW: "SESSION_CLOCK_SKEW",
  SESSION_REPLAY: "SESSION_REPLAY",
} as const;

export type AuthErrorCode = (typeof AuthErrorCode)[keyof typeof AuthErrorCode];
