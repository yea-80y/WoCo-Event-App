import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import type { SitePalette } from "@woco/shared";
import { getResend, getFromAddress } from "../lib/email/client.js";
import { renderTicketCardPng } from "../lib/ticket/render-card.js";
import { mintGateToken } from "../lib/gate/token.js";
import { hashEmail } from "../lib/event/claim-service.js";

const tickets = new Hono<AppEnv>();

/** Rate limiter: email → timestamps */
const emailRateMap = new Map<string, number[]>();
const RATE_LIMIT = 3;
const RATE_WINDOW = 300_000; // 5 min

/** Public base URL the server is reachable on (e.g. https://events-api.woco-net.com).
 *  Required for ticket links + composite PNG OG image URLs. Falls back to a
 *  relative path so dev/test still works without the env. */
const PUBLIC_API_BASE = (process.env.PUBLIC_API_BASE || "").replace(/\/$/, "");

export interface TicketEmailOpts {
  to: string;
  eventTitle: string;
  eventDate?: string;
  eventLocation?: string;
  seriesName?: string;
  /** All tickets in the order. Single ticket = array of one element. */
  tickets: Array<{ edition: number | null; qrContent: string }>;
  totalSupply?: number;
  /** Optional buyer name (from Stripe customer details). Baked into the
   *  composite PNG and shown on the standalone ticket page. */
  buyerName?: string;
  /** Organiser site palette — when present, email + PNG card match their brand.
   *  Falls back to WoCo Concrete & Acid defaults when absent. */
  palette?: SitePalette;
  /** Organiser site ID — appended to ticket page URLs so the standalone page
   *  can look up the site palette and render in the organiser's brand colours. */
  siteId?: string;
  /** Add the "Create your WoCo profile" CTA (Route A gate token). Set ONLY on
   *  paths where `to` is the VERIFIED purchase email (Stripe webhook). The
   *  public /send-email route must never set it: its recipient is arbitrary,
   *  and a gate token minted for an arbitrary inbox would let anyone holding
   *  a leaked /t link bind the ticket without knowing the purchase email. */
  profileCta?: boolean;
}

/** Canonical app host for email CTAs. Emails are rendered server-side with no
 *  request context, so this cannot come from Origin/Referer. */
const APP_BASE = (process.env.FRONTEND_URL || "https://woco.eth.limo").replace(/\/$/, "");

/** Route A signup-landing URL for one ticket, or null when the QR is
 *  unparseable. The token rides in the hash fragment — never sent to any
 *  server on page load; the SPA POSTs it to /api/attendee-gate/redeem. */
function gateCtaUrl(qrContent: string, to: string): string | null {
  const p = parseQrContent(qrContent);
  if (!p) return null;
  try {
    const token = mintGateToken({
      eventId: p.eventId,
      seriesId: p.seriesId,
      edition: p.edition,
      emailHash: hashEmail(to),
    });
    return `${APP_BASE}/#/signup?gt=${token}`;
  } catch {
    return null; // EMAIL_HASH_SECRET missing (dev) — email just has no CTA
  }
}

/** Parse `woco://t/{eventId}/{seriesId}/{edition}/{sig}` → its parts.
 *  Returns null on malformed input — caller should fall back gracefully. */
function parseQrContent(qr: string): { eventId: string; seriesId: string; edition: number; sig: string } | null {
  const m = qr.match(/^woco:\/\/t\/([^/]+)\/([^/]+)\/(\d+)\/(.+)$/);
  if (!m) return null;
  const edition = Number(m[3]);
  if (!Number.isInteger(edition) || edition < 1) return null;
  return { eventId: m[1], seriesId: m[2], edition, sig: m[4] };
}

/** Build the public URL for a ticket — both the HTML page and the composite
 *  PNG share the same base; the .png suffix toggles between them. */
function ticketUrl(qrContent: string, buyerEmail?: string, buyerName?: string, png = false, siteId?: string): string | null {
  const p = parseQrContent(qrContent);
  if (!p) return null;
  const params = new URLSearchParams();
  if (buyerName) params.set("n", buyerName);
  if (buyerEmail) params.set("e", buyerEmail);
  if (siteId) params.set("s", siteId);
  const q = params.toString();
  const path = `/t/${p.eventId}/${p.seriesId}/${p.edition}/${p.sig}${png ? ".png" : ""}`;
  return `${PUBLIC_API_BASE}${path}${q ? `?${q}` : ""}`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildTicketHtml(opts: TicketEmailOpts): string {
  const { to, eventTitle, eventDate, eventLocation, seriesName, tickets: tix, totalSupply, buyerName, palette: p, siteId } = opts;
  // Resolved palette — organiser brand when available, WoCo Concrete & Acid otherwise
  const c = {
    bg:      p?.bg      ?? '#0B0B09',
    cardBg:  p?.cardBg  ?? '#14140F',
    headerBg: p?.cardBg  ?? '#1B1A14',
    text:    p?.text    ?? '#F2EBE0',
    muted:   p?.muted   ?? '#8A8478',
    accent:  p?.accent  ?? '#C7F23A',
    border:  p?.border  ?? '#2B2A23',
  };
  const dateStr = eventDate
    ? new Date(eventDate).toLocaleDateString(undefined, {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
      })
    : null;

  const multiTicket = tix.length > 1;
  const ticketBlocks = tix.map(({ edition, qrContent }, i) => {
    const editionStr = edition != null ? String(edition).padStart(3, "0") : null;
    // Standalone HTML page: fast server-rendered, no SPA load.
    const pageUrl = ticketUrl(qrContent, to, buyerName, false, siteId);
    const cid = `woco-card-${i}`;
    // Group buys: each ticket carries its own one-shot signup link — forward a
    // ticket to a friend and their click binds THAT edition, not the buyer's.
    const perTicketCta = opts.profileCta && multiTicket ? gateCtaUrl(qrContent, to) : null;
    return `
      <div class="qr-section">
        ${editionStr ? `<div class="qr-label">Ticket #${editionStr}</div>` : `<div class="qr-label">Show at the door</div>`}
        <img src="cid:${cid}" alt="Ticket — show at the door" class="qr-image" width="320" height="440" />
        ${pageUrl ? `<a href="${escHtml(pageUrl)}" class="qr-link">Open ticket page${editionStr ? ` #${editionStr}` : ""} →</a>` : ""}
        ${perTicketCta ? `<div class="cta-mini"><a href="${escHtml(perTicketCta)}">Create a WoCo profile with this ticket →</a></div>` : ""}
      </div>`;
  }).join("\n");

  const mainCtaUrl = opts.profileCta ? gateCtaUrl(tix[0].qrContent, to) : null;
  const ctaBlock = mainCtaUrl ? `
        <div class="cta-section">
          <div class="cta-title">Save your ticket to a WoCo account</div>
          <p class="cta-copy">Create your free profile to keep your ticket${multiTicket ? "s" : ""} linked to you, follow the events you love, and check in faster at the door.</p>
          <a href="${escHtml(mainCtaUrl)}" class="cta-btn">Create your WoCo profile →</a>
          ${multiTicket ? `<p class="cta-note">Each ticket unlocks one profile — forward a ticket to your friends and they can create their own.</p>` : ""}
        </div>` : "";

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
    body { background: ${c.bg}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: ${c.text}; }
    .wrap { max-width: 560px; margin: 0 auto; padding: 32px 16px; }
    .card { background: ${c.cardBg}; border: 1px solid ${c.border}; border-radius: 8px; overflow: hidden; }
    .header { background: ${c.headerBg}; border-bottom: 1px solid ${c.border}; padding: 32px 32px 24px; }
    .badge { display: inline-block; background: ${c.accent}1a; border: 1px solid ${c.accent}38; color: ${c.accent}; font-size: 10px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; padding: 3px 10px; border-radius: 2px; margin-bottom: 14px; }
    h1 { font-size: 22px; font-weight: 800; color: ${c.text}; line-height: 1.2; letter-spacing: -0.02em; }
    .meta { margin-top: 12px; display: flex; flex-direction: column; gap: 5px; }
    .meta-row { font-size: 12px; color: ${c.muted}; }
    .body { padding: 28px 32px; }
    .qr-section { background: ${c.border}22; border: 1px solid ${c.border}; border-radius: 4px; padding: 24px 16px; text-align: center; margin-bottom: 16px; }
    .qr-label { font-size: 10px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: ${c.muted}; margin-bottom: 14px; }
    .qr-image { display: block; margin: 0 auto 16px; max-width: 100%; height: auto; border-radius: 4px; }
    .qr-link { display: inline-block; background: ${c.accent}14; border: 1px solid ${c.accent}33; color: ${c.accent}; font-size: 12px; font-weight: 600; text-decoration: none; padding: 10px 20px; border-radius: 4px; }
    .cta-mini { margin-top: 12px; }
    .cta-mini a { color: ${c.muted}; font-size: 11px; text-decoration: underline; }
    .cta-section { border: 1px solid ${c.accent}38; background: ${c.accent}0d; border-radius: 4px; padding: 22px 20px; text-align: center; margin-top: 20px; }
    .cta-title { font-size: 14px; font-weight: 700; color: ${c.text}; margin-bottom: 8px; }
    .cta-copy { font-size: 12px; color: ${c.muted}; line-height: 1.6; margin-bottom: 16px; }
    .cta-btn { display: inline-block; background: ${c.accent}; color: ${c.bg}; font-size: 13px; font-weight: 700; text-decoration: none; padding: 12px 24px; border-radius: 4px; }
    .cta-note { font-size: 11px; color: ${c.muted}; margin-top: 12px; }
    .instructions { font-size: 13px; color: ${c.muted}; line-height: 1.65; margin-top: 8px; }
    .footer { border-top: 1px solid ${c.border}; padding: 20px 32px; font-size: 11px; color: ${c.muted}; }
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
        ${ctaBlock}
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
 * Each ticket is shipped as a composite PNG (event metadata + buyer email
 * + QR all baked into one image) referenced inline via `cid:` URIs. CIDs
 * are the most reliable cross-client way to embed images — Gmail, Apple
 * Mail, Outlook all render them without going through image proxies that
 * strip QRs. The QR payload inside the PNG is the same
 * `woco://t/{eventId}/{seriesId}/{edition}/{sig}` URI as the in-app
 * passport QR, so any WoCo scanner at the door reads the same ticket.
 */
export async function sendTicketEmail(opts: TicketEmailOpts): Promise<void> {
  const resend = getResend();
  const fromAddress = getFromAddress();
  const { to, eventTitle, eventDate, eventLocation, tickets: tix, buyerName, palette } = opts;
  const subjectEdition = tix.length === 1 && tix[0].edition != null
    ? ` #${String(tix[0].edition).padStart(3, "0")}`
    : tix.length > 1 ? ` (×${tix.length})` : "";

  const attachments = await Promise.all(
    tix.map(async ({ edition, qrContent }, i) => {
      const png = await renderTicketCardPng({
        eventTitle,
        eventDate,
        eventLocation,
        edition,
        buyerEmail: to,
        buyerName,
        qrContent,
        palette,
      });
      const editionStr = edition != null ? String(edition).padStart(3, "0") : String(i + 1);
      return {
        filename: `ticket-${editionStr}.png`,
        content: png,
        contentId: `woco-card-${i}`,
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
    buyerName?: string;
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
      buyerName: body.buyerName,
    });
    return c.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Email send failed";
    console.error("[tickets/send-email] error:", err);
    return c.json({ ok: false, error: msg }, 500);
  }
});

export { tickets };
