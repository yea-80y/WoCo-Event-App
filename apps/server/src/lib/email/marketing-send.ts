/**
 * Marketing/broadcast send service — the ONLY path allowed to send
 * non-transactional email. Enforces the compliance invariants no caller may
 * opt out of:
 *   1. suppression check per recipient (server-side, regardless of what the
 *      client filtered)
 *   2. RFC 8058 List-Unsubscribe + List-Unsubscribe-Post headers
 *   3. visible unsubscribe link + provenance + postal address in the body
 *   4. a text/plain alternative part carrying the same three obligations
 * ESP seam: keep all Resend specifics here + client.ts so a future SES
 * migration touches only lib/email/.
 */

import { sendEmail, type OutboundEmail, type SendEmailOptions } from "./send.js";
import { footerHtml, footerText, withFooter, htmlToPlainText } from "./marketing-footer.js";
import { hashEmail } from "../event/claim-service.js";
import { isSuppressed } from "../marketing/suppression-store.js";
import { mintUnsubToken } from "../marketing/unsub-token.js";

/**
 * In-flight concurrency, NOT a rate limit. The account-wide messages/second cap
 * is enforced by the token bucket in `send.ts`, which also makes transactional
 * mail overtake this loop — so a broadcast can no longer delay a paid ticket.
 *
 * It does have to be large enough for the limiter to be the binding constraint,
 * because `maxInlineRecipients()` sizes a broadcast against the token rate.
 * Real throughput is `min(rate, SEND_CHUNK / latency)`, so at 12/s the limiter
 * only binds while mean latency stays under `SEND_CHUNK / 12`. At 5 that was
 * 417ms — inside SES's p50 but not its tail, and a broadcast sized for 12/s
 * that actually ran at 10/s could reach the edge timeout. At 10 the threshold
 * is 833ms, which the tail comfortably clears.
 *
 * Not raised further: each in-flight send holds its rendered body in memory.
 */
const SEND_CHUNK = 10;

export interface MarketingSendResult {
  sent: number;
  suppressed: number;
  failed: number;
  errors: string[];
}

export interface MarketingSendOptions {
  organiserAddress: string;
  /** Display name for the from header, e.g. event title or brand name */
  fromDisplayName: string;
  /** Resolved from-address; caller decides (verified org domain or platform) */
  fromAddress: string;
  subject: string;
  html: string;
  recipients: Array<{ email: string; name?: string }>;
}

/**
 * Injected outbound seam. Production always uses `sendEmail`; tests pass a
 * recorder so the compliance invariants above can be asserted on the actual
 * messages, not just on the footer builder in isolation. Same dependency-
 * injection shape as `sendSponsorTx`.
 */
export interface MarketingSendDeps {
  send: (msg: OutboundEmail, opts?: SendEmailOptions) => Promise<void>;
}

export async function sendMarketingBatch(
  opts: MarketingSendOptions,
  deps: MarketingSendDeps = { send: sendEmail },
): Promise<MarketingSendResult> {
  const apiBase = (process.env.PUBLIC_API_BASE || "").replace(/\/$/, "");
  if (!apiBase) {
    // Without a public base URL the unsubscribe links would be broken —
    // refuse to send marketing at all rather than send non-compliant mail.
    throw new Error("PUBLIC_API_BASE is not set — cannot build unsubscribe links");
  }

  // CAN-SPAM §7704(a)(5) requires a physical postal address in every
  // commercial message, and mailbox providers check for one. Fail closed for
  // the same reason as the unsubscribe URL: a send that cannot be compliant
  // must not happen at all.
  const postalAddress = (process.env.MARKETING_POSTAL_ADDRESS || "").replace(/\s+/g, " ").trim();
  if (!postalAddress) {
    throw new Error(
      "MARKETING_POSTAL_ADDRESS is not set — commercial email requires a physical postal address",
    );
  }

  const organiserAddress = opts.organiserAddress.toLowerCase();
  // Strip control chars so caller-supplied strings can never smuggle header
  // material (Resend's API is JSON, but this seam must not depend on that).
  const displayName = opts.fromDisplayName.replace(/[\r\n\x00-\x1f"]/g, "'").slice(0, 60);
  const subject = opts.subject.replace(/[\r\n\x00-\x1f]+/g, " ").trim();
  const from = `"${displayName}" <${opts.fromAddress}>`;

  const result: MarketingSendResult = { sent: 0, suppressed: 0, failed: 0, errors: [] };

  interface Prepared {
    email: string;
    unsubUrl: string;
  }
  const prepared: Prepared[] = [];
  const seen = new Set<string>();

  for (const r of opts.recipients) {
    const emailHash = hashEmail(r.email);
    if (seen.has(emailHash)) continue; // dedupe within the batch
    seen.add(emailHash);
    if (isSuppressed(emailHash, organiserAddress)) {
      result.suppressed++;
      continue;
    }
    const token = mintUnsubToken({ emailHash, organiserAddress });
    prepared.push({ email: r.email, unsubUrl: `${apiBase}/u/${token}` });
  }

  // Rendered once — the organiser's body is identical for every recipient;
  // only the per-recipient unsubscribe URL in the footer differs.
  const bodyText = htmlToPlainText(opts.html);

  for (let i = 0; i < prepared.length; i += SEND_CHUNK) {
    const chunk = prepared.slice(i, i + SEND_CHUNK);
    const settled = await Promise.allSettled(
      chunk.map(async (p) => {
        const ctx = { displayName, unsubUrl: p.unsubUrl, postalAddress };
        await deps.send(
          {
            from,
            to: [p.email],
            subject,
            html: withFooter(opts.html, footerHtml(ctx)),
            text: bodyText + footerText(ctx),
            headers: {
              "List-Unsubscribe": `<${p.unsubUrl}>`,
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            },
          },
          // Yields the send-rate budget to transactional mail, and keeps this
          // batch off the transactional-only failover path.
          { priority: "marketing", context: { organiser: organiserAddress } },
        );
      }),
    );
    settled.forEach((s, j) => {
      if (s.status === "fulfilled") {
        result.sent++;
      } else {
        result.failed++;
        const msg = s.reason instanceof Error ? s.reason.message : "Unknown error";
        // The returned error keeps the plaintext address: it goes back to the
        // organiser, who is the controller and supplied it. The LOG must not —
        // docker logs persist far longer than the send, which would quietly
        // undo the hashed-and-discarded posture the rest of this path keeps.
        result.errors.push(`${chunk[j].email}: ${msg}`);
        console.error(
          `[marketing-send] Failed to send to ${hashEmail(chunk[j].email).slice(0, 8)}…:`,
          msg,
        );
      }
    });
  }

  return result;
}
