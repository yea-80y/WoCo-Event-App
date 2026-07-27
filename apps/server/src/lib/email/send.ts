/**
 * The single outbound email chokepoint. Every send in the codebase goes through
 * `sendEmail` — no route or lib may import the ESP SDK directly.
 *
 * This exists so the SES migration is one new provider file plus one branch in
 * `selectProvider`, rather than a hunt through routes. See
 * docs/PRICING_AND_EMAIL.md §5 for the migration triggers.
 *
 * Compliance note: this layer is deliberately dumb. Suppression, unsubscribe
 * headers and the provenance footer live in `marketing-send.ts`, which is the
 * only caller allowed to send non-transactional mail. Adding a bypass here
 * would defeat that control.
 */

import { getResend } from "./client.js";

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
}

export interface EmailProvider {
  readonly name: string;
  /** Resolves on accepted-for-delivery; throws with a usable message otherwise. */
  send(msg: OutboundEmail): Promise<void>;
}

const resendProvider: EmailProvider = {
  name: "resend",
  async send(msg) {
    const { error } = await getResend().emails.send({
      from: msg.from,
      to: msg.to,
      subject: msg.subject,
      ...(msg.html ? { html: msg.html } : {}),
      ...(msg.text ? { text: msg.text } : {}),
      ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
      ...(msg.headers ? { headers: msg.headers } : {}),
      ...(msg.attachments ? { attachments: msg.attachments } : {}),
    } as Parameters<ReturnType<typeof getResend>["emails"]["send"]>[0]);
    if (error) throw new Error(error.message);
  },
};

let provider: EmailProvider | null = null;

function selectProvider(): EmailProvider {
  if (provider) return provider;
  const name = (process.env.EMAIL_PROVIDER || "resend").toLowerCase();
  switch (name) {
    case "resend":
      provider = resendProvider;
      break;
    default:
      // Fail loud: a typo in EMAIL_PROVIDER must not silently drop ticket email.
      throw new Error(`Unknown EMAIL_PROVIDER "${name}"`);
  }
  return provider;
}

export async function sendEmail(msg: OutboundEmail): Promise<void> {
  if (!msg.to.length) throw new Error("sendEmail: no recipients");
  await selectProvider().send(msg);
}

/** Which ESP is live — for /api/health and startup logging. */
export function activeEmailProvider(): string {
  return (process.env.EMAIL_PROVIDER || "resend").toLowerCase();
}
