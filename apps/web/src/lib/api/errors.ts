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
 * A failed response body as it reaches the client, kept OPEN: routes send
 * structured detail alongside the code — when a rate cap resets, when a
 * cooldown ends, which label was refused — and `safeJson` spreads the whole
 * body, so it all arrives. Readers type-check each field they pull out.
 */
export type ApiErrorBody = Readonly<Record<string, unknown>>;

/** The declared part of any failure envelope. */
export interface ApiFailure {
  error?: string;
  code?: string;
  status?: number;
}

/**
 * A failed API call with its envelope intact.
 *
 * `throw new Error(resp.error)` is lossy, and the loss is not academic: it is
 * why the rename cooldown could only ever render as the literal string
 * "name_change_cooldown" — the field saying WHEN it ends was already on the
 * object and was dropped at the throw (#484).
 */
export class ApiError extends Error {
  readonly status?: number;
  /** Machine-readable code. Routes older than `ApiResponse.code` put theirs in
   *  `error` (every sub-ENS route does), so that is the fallback. */
  readonly code?: string;
  readonly body: ApiErrorBody;
  constructor(message: string, body: ApiErrorBody) {
    super(message);
    this.name = "ApiError";
    this.body = body;
    this.status = typeof body.status === "number" ? body.status : undefined;
    const code = typeof body.code === "string" ? body.code : undefined;
    this.code = code ?? (typeof body.error === "string" ? body.error : undefined);
  }
}

/**
 * Turn a failed `ApiResponse` into the right Error to throw. Callers keep their
 * own fallback message for the codeless case.
 */
export function apiError(resp: ApiFailure, fallback: string): Error {
  const message = resp.error || fallback;
  if (resp.code === MarketingSenderUnavailable.CODE) {
    return new MarketingSenderUnavailable(message);
  }
  // TypeScript will not widen an interface to an index-signature type on its
  // own; the widening is safe because nothing reads a field without checking
  // its type first.
  return new ApiError(message, resp as unknown as ApiErrorBody);
}
