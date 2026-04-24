import { Hono } from "hono";
import QRCode from "qrcode";
import type { AppEnv } from "../types.js";
import { getResend, getFromAddress } from "../lib/email/client.js";

const tickets = new Hono<AppEnv>();

/** Rate limiter: email → timestamps */
const emailRateMap = new Map<string, number[]>();
const RATE_LIMIT = 3;
const RATE_WINDOW = 300_000; // 5 min

export interface TicketEmailOpts {
  to: string;
  eventTitle: string;
  eventDate?: string;
  eventLocation?: string;
  seriesName?: string;
  /** All tickets in the order. Single ticket = array of one element. */
  tickets: Array<{ edition: number | null; qrContent: string }>;
  totalSupply?: number;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildTicketHtml(opts: TicketEmailOpts): string {
  const { eventTitle, eventDate, eventLocation, seriesName, tickets: tix, totalSupply } = opts;
  const dateStr = eventDate
    ? new Date(eventDate).toLocaleDateString(undefined, {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
      })
    : null;

  const ticketBlocks = tix.map(({ edition, qrContent }, i) => {
    const editionStr = edition != null ? String(edition).padStart(3, "0") : null;
    const verifyUrl = `https://woco.eth.limo/#/verify?t=${encodeURIComponent(qrContent)}`;
    const cid = `woco-qr-${i}`;
    return `
      <div class="qr-section">
        ${editionStr ? `<div class="qr-label">Ticket #${editionStr}</div>` : `<div class="qr-label">Show at the door</div>`}
        <img src="cid:${cid}" alt="Ticket QR code" class="qr-image" width="220" height="220" />
        <a href="${escHtml(verifyUrl)}" class="qr-link">Open &amp; Verify Ticket${editionStr ? ` #${editionStr}` : ""} →</a>
        <div class="ticket-id">${escHtml(qrContent)}</div>
      </div>`;
  }).join("\n");

  const countLabel = tix.length > 1 ? `${tix.length} Tickets` : "Your Ticket";
  const subjectEdition = tix.length === 1 && tix[0].edition != null
    ? ` #${String(tix[0].edition).padStart(3, "0")}`
    : tix.length > 1 ? ` (×${tix.length})` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0d0a07; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #f5f0ea; }
    .wrap { max-width: 560px; margin: 0 auto; padding: 32px 16px; }
    .card { background: #191410; border: 1px solid rgba(255,255,255,0.07); border-radius: 16px; overflow: hidden; }
    .header { background: linear-gradient(135deg, #231a0f 0%, #140e08 100%); padding: 32px 32px 24px; }
    .badge { display: inline-block; background: rgba(245,158,11,0.15); border: 1px solid rgba(245,158,11,0.3); color: #f59e0b; font-size: 10px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; padding: 3px 10px; border-radius: 4px; margin-bottom: 14px; }
    h1 { font-size: 22px; font-weight: 800; color: #f5f0ea; line-height: 1.2; letter-spacing: -0.02em; }
    .meta { margin-top: 12px; display: flex; flex-direction: column; gap: 5px; }
    .meta-row { font-size: 12px; color: rgba(245,240,234,0.4); }
    .body { padding: 28px 32px; }
    .qr-section { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; padding: 24px; text-align: center; margin-bottom: 16px; }
    .qr-label { font-size: 10px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: rgba(255,255,255,0.22); margin-bottom: 14px; }
    .qr-image { display: block; margin: 0 auto 16px; width: 220px; height: 220px; background: #fff; border-radius: 10px; padding: 12px; }
    .qr-link { display: inline-block; background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.25); color: #f59e0b; font-size: 12px; font-weight: 600; text-decoration: none; padding: 10px 20px; border-radius: 8px; }
    .ticket-id { margin-top: 14px; font-family: 'SF Mono', 'Cascadia Code', monospace; font-size: 10px; color: rgba(255,255,255,0.18); word-break: break-all; }
    .instructions { font-size: 13px; color: rgba(245,240,234,0.45); line-height: 1.65; margin-top: 8px; }
    .footer { border-top: 1px solid rgba(255,255,255,0.05); padding: 20px 32px; font-size: 11px; color: rgba(255,255,255,0.18); }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="header">
        <div class="badge">${escHtml(countLabel)}${subjectEdition}</div>
        <h1>${escHtml(eventTitle)}</h1>
        <div class="meta">
          ${dateStr ? `<div class="meta-row">📅 ${escHtml(dateStr)}</div>` : ""}
          ${eventLocation ? `<div class="meta-row">📍 ${escHtml(eventLocation)}</div>` : ""}
          ${seriesName ? `<div class="meta-row">🎫 ${escHtml(seriesName)}${totalSupply ? ` · ${totalSupply} total` : ""}</div>` : ""}
        </div>
      </div>
      <div class="body">
        ${ticketBlocks}
        <p class="instructions">
          Present this email or open a link above to display your ticket QR code at the venue entrance.
          Your ticket${tix.length > 1 ? "s are" : " is"} cryptographically signed and can be verified offline.
        </p>
      </div>
      <div class="footer">
        Powered by WoCo · Decentralised event ticketing on Ethereum Swarm
      </div>
    </div>
  </div>
</body>
</html>`;
}

/** Send ticket confirmation email(s). Exported for use by the Stripe webhook handler.
 *
 * QR codes are generated as inline PNG attachments referenced in the HTML via
 * `cid:` URIs — this is the most reliable way to embed images that works
 * across Gmail, Apple Mail, Outlook and other major clients without being
 * stripped by image proxies. The PNG encodes the full POD ticket URI
 * (`woco://t/{eventId}/{seriesId}/{edition}/{originalSignature}`) so a QR
 * scanner at the door reads the same verifiable payload as the in-app
 * passport QR.
 */
export async function sendTicketEmail(opts: TicketEmailOpts): Promise<void> {
  const resend = getResend();
  const fromAddress = getFromAddress();
  const { to, eventTitle, tickets: tix } = opts;
  const subjectEdition = tix.length === 1 && tix[0].edition != null
    ? ` #${String(tix[0].edition).padStart(3, "0")}`
    : tix.length > 1 ? ` (×${tix.length})` : "";

  const attachments = await Promise.all(
    tix.map(async ({ edition, qrContent }, i) => {
      const png = await QRCode.toBuffer(qrContent, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 512,
        color: { dark: "#000000", light: "#ffffff" },
      });
      const editionStr = edition != null ? String(edition).padStart(3, "0") : String(i + 1);
      return {
        filename: `ticket-${editionStr}.png`,
        content: png,
        contentId: `woco-qr-${i}`,
        contentType: "image/png",
      };
    }),
  );

  await resend.emails.send({
    from: `"${eventTitle.slice(0, 40)}" <${fromAddress}>`,
    to: [to],
    subject: `Your ticket${subjectEdition} — ${eventTitle}`,
    html: buildTicketHtml(opts),
    attachments,
  });
}

tickets.post("/send-email", async (c) => {
  const body = await c.req.json().catch(() => null) as {
    to?: string;
    eventTitle?: string;
    eventDate?: string;
    eventLocation?: string;
    seriesName?: string;
    edition?: number | null;
    totalSupply?: number;
    qrContent?: string;
    /** Multi-ticket: overrides single edition+qrContent when present */
    tickets?: Array<{ edition: number | null; qrContent: string }>;
  } | null;

  if (!body?.to || !body.to.includes("@")) {
    return c.json({ ok: false, error: "Valid email address required" }, 400);
  }
  if (!body.eventTitle || (!body.qrContent && !body.tickets?.length)) {
    return c.json({ ok: false, error: "Missing required fields" }, 400);
  }

  // Rate limit per recipient
  const now = Date.now();
  const history = (emailRateMap.get(body.to) ?? []).filter((t) => now - t < RATE_WINDOW);
  if (history.length >= RATE_LIMIT) {
    return c.json({ ok: false, error: "Too many emails to this address — try again shortly" }, 429);
  }
  emailRateMap.set(body.to, [...history, now]);

  const ticketsList = body.tickets?.length
    ? body.tickets
    : [{ edition: body.edition ?? null, qrContent: body.qrContent! }];

  try {
    await sendTicketEmail({
      to: body.to,
      eventTitle: body.eventTitle,
      eventDate: body.eventDate,
      eventLocation: body.eventLocation,
      seriesName: body.seriesName,
      totalSupply: body.totalSupply,
      tickets: ticketsList,
    });
    return c.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Email send failed";
    console.error("[tickets/send-email] error:", err);
    return c.json({ ok: false, error: msg }, 500);
  }
});

export { tickets };
