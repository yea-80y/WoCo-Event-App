/**
 * "A ticket for your event didn't arrive" (#983) - the organiser's half of the
 * undelivered-ticket alarm, which otherwise reaches WoCo only.
 *
 * Sent to the contact address on the organiser's site, the one address an organiser
 * has given us to be reached at; an event sold without a site has none, and its
 * dashboard shows the same thing. It names the event and nothing about the buyer:
 * the dashboard, behind the organiser's sign-in, is where the order is.
 *
 * At most one per event every 6 hours, however many tickets bounce - a mistyped batch
 * or a provider outage must not turn into a stream of email. In memory: a restart may
 * send one more, never fewer than one.
 */

import type { EmailFailure } from "../email/failure-ledger.js";
import { companyFooterHtml, companyFooterText } from "../email/company-footer.js";

export const NOTICE_EVERY_MS = 6 * 60 * 60 * 1000;

export interface NoticeDeps {
  /** The site's contact address - null unless the site is this event's organiser's (the siteId came from checkout). */
  getSiteTheme(siteId: string, eventId: string): Promise<{ contactEmail?: string } | null>;
  getEventTitle(eventId: string): Promise<string | null>;
  send(msg: { to: string; subject: string; html: string; text: string }, context: Record<string, string>): Promise<void>;
  /** Where the organiser's dashboard for an event lives. */
  dashboardUrl(eventId: string): string;
  now(): number;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function buildUndeliveredNotice(title: string, url: string): { subject: string; html: string; text: string } {
  const name = title.trim().slice(0, 120) || "your event";
  const subject = `A ticket for ${name} didn't arrive`;
  const lead = `A buyer's ticket email for ${name} bounced, so they don't have their ticket yet.`;
  const next =
    "When they get in touch, check them against the order, then resend the same ticket to the address they give you. " +
    "It's all on your event dashboard.";
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:40px 16px;">
    <table width="100%" style="max-width:480px;margin:0 auto;background:#222;border:1px solid #333;border-radius:8px;">
      <tr><td style="padding:32px 28px;">
        <p style="margin:0 0 16px;color:#e8e8e4;font-size:16px;line-height:1.6;">${escHtml(lead)}</p>
        <p style="margin:0 0 24px;color:#9a9a94;font-size:14px;line-height:1.6;">${escHtml(next)}</p>
        <a href="${escHtml(url)}"
           style="display:inline-block;padding:12px 20px;background:#C7F23A;color:#0B0B09;
                  font-size:14px;font-weight:600;text-decoration:none;border-radius:4px;">
          Open your dashboard
        </a>
      </td></tr>
    </table>
    <div style="max-width:480px;margin:0 auto;text-align:center;">${companyFooterHtml("#6a6a64")}</div>
  </td></tr></table>
</body>
</html>`;
  const text = `${lead}

${next}

${url}
${companyFooterText()}`;
  return { subject, html, text };
}

/** A listener for `onTicketFailure`. Never throws, never awaits on the caller's path. */
export function createUndeliveredNotifier(deps: NoticeDeps) {
  const lastSent = new Map<string, number>();
  return (row: EmailFailure): void => {
    const eventId = row.context?.eventId;
    const siteId = row.context?.siteId;
    if (!eventId || !siteId) return;
    const now = deps.now();
    const last = lastSent.get(eventId);
    if (last !== undefined && now - last < NOTICE_EVERY_MS) return;
    // Claimed before the awaits, so a burst of bounces sends one notice, not one each.
    lastSent.set(eventId, now);
    void (async () => {
      try {
        const theme = await deps.getSiteTheme(siteId, eventId);
        const to = theme?.contactEmail?.trim();
        if (!to) return;
        const title = (await deps.getEventTitle(eventId).catch(() => null)) ?? "";
        const msg = buildUndeliveredNotice(title, deps.dashboardUrl(eventId));
        // No session in the context: this notice bouncing must not read as an undelivered ticket.
        await deps.send({ to, ...msg }, { kind: "undelivered-notice", eventId });
      } catch (err) {
        console.error("[ticket-hold] organiser notice not sent:", err instanceof Error ? err.name : "unknown");
      }
    })();
  };
}
