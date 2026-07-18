/**
 * Marketing/broadcast send service — the ONLY path allowed to send
 * non-transactional email. Enforces the compliance invariants no caller may
 * opt out of:
 *   1. suppression check per recipient (server-side, regardless of what the
 *      client filtered)
 *   2. RFC 8058 List-Unsubscribe + List-Unsubscribe-Post headers
 *   3. visible unsubscribe link + provenance footer in the body
 * ESP seam: keep all Resend specifics here + client.ts so a future SES
 * migration touches only lib/email/.
 */

import { getResend } from "./client.js";
import { hashEmail } from "../event/claim-service.js";
import { isSuppressed } from "../marketing/suppression-store.js";
import { mintUnsubToken } from "../marketing/unsub-token.js";

const API_BASE = (process.env.PUBLIC_API_BASE || "").replace(/\/$/, "");

const SEND_CHUNK = 5;

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

function footerHtml(fromDisplayName: string, unsubUrl: string): string {
  return `<div style="margin-top:32px;padding-top:16px;border-top:1px solid #33343f;color:#8a8b9a;font-size:12px;line-height:1.6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
You're receiving this because you opted in to updates from ${fromDisplayName}. Sent via WoCo.<br/>
<a href="${unsubUrl}" style="color:#8a8b9a">Unsubscribe</a>
</div>`;
}

/** Inject the compliance footer just before </body>, or append. */
function withFooter(html: string, footer: string): string {
  // Only treat </body> as the insertion point when it really ends the document —
  // a mid-document </body> (e.g. inside a display:none div sent straight to the
  // API) must not let a sender tuck the footer out of sight.
  const m = /<\/body>\s*(<\/html>\s*)?$/i.exec(html);
  if (!m) return html + footer;
  return html.slice(0, m.index) + footer + html.slice(m.index);
}

export async function sendMarketingBatch(opts: MarketingSendOptions): Promise<MarketingSendResult> {
  if (!API_BASE) {
    // Without a public base URL the unsubscribe links would be broken —
    // refuse to send marketing at all rather than send non-compliant mail.
    throw new Error("PUBLIC_API_BASE is not set — cannot build unsubscribe links");
  }

  const resend = getResend();
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
    prepared.push({ email: r.email, unsubUrl: `${API_BASE}/u/${token}` });
  }

  for (let i = 0; i < prepared.length; i += SEND_CHUNK) {
    const chunk = prepared.slice(i, i + SEND_CHUNK);
    const settled = await Promise.allSettled(
      chunk.map(async (p) => {
        const { error } = await resend.emails.send({
          from,
          to: [p.email],
          subject,
          html: withFooter(opts.html, footerHtml(displayName, p.unsubUrl)),
          headers: {
            "List-Unsubscribe": `<${p.unsubUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        });
        if (error) throw new Error(error.message);
      }),
    );
    settled.forEach((s, j) => {
      if (s.status === "fulfilled") {
        result.sent++;
      } else {
        result.failed++;
        const msg = s.reason instanceof Error ? s.reason.message : "Unknown error";
        result.errors.push(`${chunk[j].email}: ${msg}`);
        console.error(`[marketing-send] Failed to send to ${chunk[j].email}:`, msg);
      }
    });
  }

  return result;
}
