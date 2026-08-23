/**
 * Shared shapes for the outbound email seam.
 *
 * Split out of `send.ts` so providers can import the types and the error class
 * without importing the dispatcher that imports them — the cycle would otherwise
 * resolve at runtime as `undefined` for `EmailSendError` under ESM, and every
 * `instanceof` check in the retry path would silently fall through.
 */

export interface OutboundAttachment {
  filename: string;
  content: Buffer;
  /** Set to reference the attachment inline from HTML as `cid:<contentId>`. */
  contentId?: string;
  contentType?: string;
}

export interface OutboundEmail {
  /** Complete From header, e.g. `"Acme" <hello@acme.com>`. */
  from: string;
  to: string[];
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string[];
  headers?: Record<string, string>;
  attachments?: OutboundAttachment[];
  /**
   * Provider-agnostic per-message tags. Stamped by `sendVia`, never by callers,
   * and echoed back on the provider's async delivery events — the only thing
   * that makes a bounce arriving minutes after acceptance attributable to the
   * send that caused it. See `message-tags.ts`.
   */
  tags?: Record<string, string>;
}

export interface EmailProvider {
  readonly name: string;
  /** Resolves on accepted-for-delivery; throws `EmailSendError` otherwise. */
  send(msg: OutboundEmail): Promise<void>;
}

export interface EmailSendErrorInit {
  /**
   * Whether a later attempt could plausibly succeed. Providers should default to
   * TRUE for anything they cannot positively classify — abandoning a deliverable
   * message is a worse error than one wasted retry.
   */
  retryable: boolean;
  /** Provider error name/code, e.g. `TooManyRequestsException`. */
  code?: string;
  status?: number;
  cause?: unknown;
}

export class EmailSendError extends Error {
  readonly retryable: boolean;
  readonly code?: string;
  readonly status?: number;
  /**
   * Set by `sendEmail` once the failure is in the undelivered ledger, so a
   * caller that must guarantee a ledger row (paid-ticket fulfilment, #314) can
   * tell "abandoned after it reached the mailer — already recorded" from "never
   * reached the mailer — record it yourself" without a second entry.
   */
  ledgered = false;

  constructor(message: string, init: EmailSendErrorInit) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "EmailSendError";
    this.retryable = init.retryable;
    if (init.code !== undefined) this.code = init.code;
    if (init.status !== undefined) this.status = init.status;
  }
}
