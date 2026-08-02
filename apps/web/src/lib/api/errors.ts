/**
 * Typed API failures the UI needs to render differently, rather than as one
 * more line of red text.
 *
 * `ApiResponse.code` is the documented branch point ("UI branches on this,
 * never on the human-readable `error` text"), but a thrown `Error` loses it.
 * These carry it across the throw.
 */

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
  readonly code = "MARKETING_SENDER_NOT_CONFIGURED";
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
  if (resp.code === "MARKETING_SENDER_NOT_CONFIGURED") {
    return new MarketingSenderUnavailable(message);
  }
  return new Error(message);
}
