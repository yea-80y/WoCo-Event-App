/**
 * Typed API failures the UI needs to render differently, rather than as one
 * more line of red text.
 *
 * `ApiResponse.code` is the documented branch point ("UI branches on this,
 * never on the human-readable `error` text"), but a thrown `Error` loses it.
 * These carry it across the throw.
 */

import { AuthErrorCode } from "@woco/shared";

/**
 * The server rejected the session, so this response answers nothing about the
 * data (#256): "unverifiable" must never render as a negative ("no events",
 * "verify with Stripe"). Screens branch on this instead of collapsing
 * `ok: false` into an empty result.
 */
export function isSessionInvalid(resp: { ok: boolean; code?: string }): boolean {
  return !resp.ok && resp.code === AuthErrorCode.SESSION_INVALID;
}

/**
 * The platform has no marketing sending address configured, so a marketing send
 * was refused (#96).
 *
 * Worth its own type because it is unlike every other failure the composer can
 * show: the organiser did nothing wrong, there is nothing they can do, and —
 * the part that actually matters to someone who just wrote to 8,000 people —
 * their draft is untouched. Rendered as a validation error it reads as "you
 * broke it, and possibly lost it", which is wrong twice.
 */
export class MarketingSenderUnavailable extends Error {
  static readonly CODE = "MARKETING_SENDER_NOT_CONFIGURED";
  readonly code = MarketingSenderUnavailable.CODE;
  constructor(message: string) {
    super(message);
    this.name = "MarketingSenderUnavailable";
  }
}

/**
 * Turn a failed `ApiResponse` into the right Error to throw. Callers keep their
 * own fallback message for the codeless case.
 */
export function apiError(
  resp: { error?: string; code?: string },
  fallback: string,
): Error {
  const message = resp.error || fallback;
  if (resp.code === MarketingSenderUnavailable.CODE) {
    return new MarketingSenderUnavailable(message);
  }
  return new Error(message);
}
