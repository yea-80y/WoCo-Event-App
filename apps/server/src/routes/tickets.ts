import type { SitePalette, TicketDisplay } from "@woco/shared";
import { buildTicketLink, TICKET_IMAGE_GATEWAYS } from "@woco/shared";
import { getFromAddress } from "../lib/email/client.js";
import { sendEmail, type OutboundAttachment } from "../lib/email/send.js";
import { renderTicketCardPng } from "../lib/ticket/render-card.js";
import { fetchEventPhoto, type EventPhoto } from "../lib/ticket/event-photo.js";
import { directionsUrl, eventIcs, googleCalendarUrl } from "../lib/ticket/calendar.js";
import { splitLocation, ticketWhen } from "@woco/shared/ticket/card";
import { mintGateToken } from "../lib/gate/token.js";
import { hashEmail } from "../lib/event/claim-service.js";
import { companyFooterHtml, companyFooterText } from "../lib/email/company-footer.js";
import { SUPPORT_EMAIL } from "@woco/shared";

/*
 * The ticket email: built and sent by Stripe fulfilment only, to the verified
 * purchase address. There is deliberately no HTTP route here. A public
 * `POST /api/tickets/send-email` (v1 claim rail) sent this email to any
 * address with caller-chosen event text and QR content, unauthenticated; it
 * had no callers after #207 and was removed on 2026-10-02.
 */

export interface TicketEmailOpts {
  to: string;
  /** The event's id: the calendar entry's stable UID. */
  eventId?: string;
  eventTitle: string;
  eventDate?: string;
  /** ISO end, for the times and the calendar entry. */
  eventEndDate?: string;
  eventLocation?: string;
  seriesName?: string;
  /** All tickets in the order. Single ticket = array of one element. */
  tickets: Array<{ edition: number | null; qrContent: string }>;
  totalSupply?: number;
  /** Buyer name from Stripe. Not drawn on the ticket: tickets get forwarded to friends. */
  buyerName?: string;
  /** Organiser site palette — when present, email + PNG card match their brand.
   *  Falls back to WoCo Concrete & Acid defaults when absent. */
  palette?: SitePalette;
  /** Swarm reference of the event image, shown on the static ticket page. */
  imageHash?: string;
  /** The gateway the event recorded its storage on (`EventFeed.gatewayUrl`); the
   *  ticket page tries it first for the image. */
  imageGateway?: string;
  /** Add the "Add to WoCo" button (Route A gate token). Set ONLY on
   *  paths where `to` is the VERIFIED purchase email (Stripe webhook): a gate
   *  token minted for an arbitrary inbox would let anyone holding a leaked /t
   *  link bind the ticket without knowing the purchase email. */
  profileCta?: boolean;
  /** Organiser contact address for the Reply-To header. Only affects where
   *  replies land — the From domain stays platform-owned so a bad organiser
   *  campaign can never tank ticket-delivery reputation (see client.ts). */
  replyTo?: string;
  /** Breadcrumbs stored with the failure if this send is finally abandoned, so
   *  an undelivered PAID ticket can be traced back to its order rather than
   *  being an anonymous line in the ledger. */
  failureContext?: Record<string, string>;
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

/** The emailed "Open ticket page" link: the static page on the app origin, with
 *  the ticket and its display details in the URL fragment, so no server - ours
 *  or anyone's - receives the signature (packages/shared/src/ticket/link.ts).
 *  Never carries the buyer's name: the page cannot tell a real one from an edit. */
export function ticketUrl(qrContent: string, display: TicketDisplay = {}): string | null {
  const p = parseQrContent(qrContent);
  if (!p) return null;
  return buildTicketLink(APP_BASE, { eventId: p.eventId, seriesId: p.seriesId, edition: p.edition, sig: p.sig }, display);
}

/** Which of the page's known image gateways the event's storage gateway is. */
function imageGatewayIndex(url: string | undefined): number {
  const clean = (url ?? "").trim().replace(/\/$/, "");
  const i = (TICKET_IMAGE_GATEWAYS as readonly string[]).indexOf(clean);
  return i === -1 ? 0 : i;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function buildTicketHtml(opts: TicketEmailOpts, media: { hero?: boolean } = {}): string {
  const { to, eventTitle, eventDate, eventEndDate, eventLocation, seriesName, tickets: tix, palette: p, imageHash, imageGateway } = opts;
  const display: TicketDisplay = {
    title: eventTitle,
    date: eventDate,
    location: eventLocation,
    series: seriesName,
    image: imageHash,
    gateway: imageGatewayIndex(imageGateway),
  };
  // Resolved palette — organiser brand when available, WoCo Concrete & Acid otherwise
  const c = {
    bg:        p?.bg     ?? '#0B0B09',
    cardBg:    p?.cardBg ?? '#14140F',
    text:      p?.text   ?? '#F2EBE0',
    secondary: p?.muted  ?? '#B5AC9D',
    muted:     p?.muted  ?? '#8A8478',
    accent:    p?.accent ?? '#C7F23A',
    border:    p?.border ?? '#2B2A23',
  };
  const when = ticketWhen(eventDate, eventEndDate, "long");
  const where = splitLocation(eventLocation);
  const calendar = googleCalendarUrl({ eventId: opts.eventId ?? "", title: eventTitle, startIso: eventDate, endIso: eventEndDate, location: eventLocation });
  const directions = directionsUrl(eventLocation);
  const multiTicket = tix.length > 1;

  // Buyers never see the edition (its sequence leaks how many have sold); a
  // group order numbers its own tickets so the buyer can hand them out.
  const ticketRows = tix.map(({ qrContent }, i) => {
    const label = multiTicket ? `Ticket ${i + 1} of ${tix.length}` : "Your ticket";
    const pageUrl = ticketUrl(qrContent, display);
    // Group buys: each ticket carries its own one-shot signup link — forward a
    // ticket to a friend and their click binds THAT edition, not the buyer's.
    const perTicketCta = opts.profileCta && multiTicket ? gateCtaUrl(qrContent, to) : null;
    return `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="row"><tr>
              <td class="row-l">
                <div class="row-title">${escHtml(label)}</div>
                ${seriesName ? `<div class="row-sub">${escHtml(seriesName)}</div>` : ""}
                ${perTicketCta ? `<a href="${escHtml(perTicketCta)}" class="row-add">Add this ticket to WoCo</a>` : ""}
              </td>
              <td class="row-r">${pageUrl ? `<a href="${escHtml(pageUrl)}" class="btn">Open ticket</a>` : ""}</td>
            </tr></table>`;
  }).join("");

  const mainCtaUrl = opts.profileCta ? gateCtaUrl(tix[0].qrContent, to) : null;
  const ctaBlock = mainCtaUrl ? `
          <div class="panel">
            <div class="panel-title">${multiTicket ? "Add a ticket to WoCo" : "Keep your ticket in WoCo"}</div>
            <p class="panel-copy">Keep it in your WoCo passport and claim your own name on WoCo. It's free.</p>
            <a href="${escHtml(mainCtaUrl)}" class="btn-outline">Add to WoCo</a>
            ${multiTicket ? `<p class="note">The button adds your first ticket. Each ticket goes into one account, so friends can add theirs with the link under each ticket.</p>` : ""}
          </div>` : "";

  const detail = (label: string, main?: string, sub?: string) => main ? `
                <td class="cell" valign="top">
                  <div class="label">${label}</div>
                  <div class="value">${escHtml(main)}</div>
                  ${sub ? `<div class="value-sub">${escHtml(sub)}</div>` : ""}
                </td>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body { margin: 0; padding: 0; background: ${c.bg}; color: ${c.text}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    .wrap { max-width: 600px; margin: 0 auto; }
    .top { padding: 20px 28px; font-family: Menlo, Consolas, monospace; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; }
    .brand { font-weight: 700; color: ${c.text}; }
    .top-r { color: ${c.muted}; float: right; }
    .hero { display: block; width: 100%; max-width: 600px; height: auto; border: 0; }
    .main { padding: 28px; }
    .kicker { font-family: Menlo, Consolas, monospace; font-size: 12px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: ${c.accent}; margin: 0 0 10px; }
    h1 { margin: 0 0 22px; font-size: 32px; line-height: 1.1; font-weight: 800; color: ${c.text}; }
    .panel { background: ${c.cardBg}; border: 1px solid ${c.border}; border-radius: 12px; padding: 20px; margin: 0 0 24px; }
    .cell { padding: 0 8px 14px 0; width: 50%; }
    .label { font-family: Menlo, Consolas, monospace; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: ${c.muted}; margin-bottom: 4px; }
    .value { font-size: 16px; font-weight: 600; color: ${c.text}; }
    .value-sub { font-size: 14px; color: ${c.secondary}; margin-top: 2px; }
    .btn-ghost { display: block; text-align: center; padding: 12px 0; border: 1px solid ${c.border}; border-radius: 8px; color: ${c.text}; text-decoration: none; font-size: 14px; font-weight: 600; }
    h2 { margin: 0 0 12px; font-size: 20px; font-weight: 700; color: ${c.text}; }
    .row { background: ${c.cardBg}; border: 1px solid ${c.border}; border-radius: 10px; margin: 0 0 10px; }
    .row-l { padding: 14px 16px; }
    .row-r { padding: 14px 16px; text-align: right; white-space: nowrap; }
    .row-title { font-size: 15px; font-weight: 600; color: ${c.text}; }
    .row-sub { font-family: Menlo, Consolas, monospace; font-size: 12px; color: ${c.muted}; margin-top: 2px; }
    .row-add { display: inline-block; margin-top: 6px; font-size: 12px; color: ${c.secondary}; }
    .btn { display: inline-block; padding: 10px 16px; background: ${c.accent}; color: ${c.bg}; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 700; }
    .btn-outline { display: inline-block; padding: 12px 20px; border: 1px solid ${c.accent}; color: ${c.accent}; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 700; }
    .tip { border: 1px dashed ${c.border}; border-radius: 10px; padding: 16px; margin: 6px 0 12px; }
    .tip-title { font-size: 15px; font-weight: 700; color: ${c.text}; margin-bottom: 6px; }
    .tip-copy, .panel-copy { font-size: 14px; line-height: 1.5; color: ${c.secondary}; margin: 0 0 14px; }
    .tip-copy { margin: 0; }
    .small { font-size: 13px; color: ${c.muted}; margin: 0 0 24px; }
    .note { font-size: 12px; color: ${c.muted}; margin: 12px 0 0; }
    .help { font-size: 14px; line-height: 1.5; color: ${c.secondary}; }
    .help a { color: ${c.accent}; }
    .footer { border-top: 1px solid ${c.border}; padding: 22px 28px 28px; font-size: 11px; line-height: 1.5; color: ${c.muted}; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top"><span class="brand">WoCo</span><span class="top-r">${multiTicket ? "Your tickets" : "Your ticket"}</span></div>
    ${media.hero ? `<img src="cid:${HERO_CID}" alt="${escHtml(eventTitle)}" class="hero" width="600" />` : ""}
    <div class="main">
      <div class="kicker">You're going</div>
      <h1>${escHtml(eventTitle)}</h1>
      ${when.day || where.venue || calendar || directions ? `
      <div class="panel">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          ${detail("When", when.day, when.time)}
          ${detail("Where", where.venue, where.rest)}
        </tr></table>
        ${calendar || directions ? `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          ${calendar ? `<td style="padding-right:${directions ? 5 : 0}px;width:50%"><a href="${escHtml(calendar)}" class="btn-ghost">Add to calendar</a></td>` : ""}
          ${directions ? `<td style="padding-left:${calendar ? 5 : 0}px;width:50%"><a href="${escHtml(directions)}" class="btn-ghost">Get directions</a></td>` : ""}
        </tr></table>` : ""}
      </div>` : ""}
      <h2>${multiTicket ? "Your tickets" : "Your ticket"}</h2>${ticketRows}
      ${multiTicket ? `
      <div class="tip">
        <div class="tip-title">Going with friends?</div>
        <p class="tip-copy">Send each person their own ticket: open it, then share or save it. Every ticket lets one person in and the first scan wins, so send each one to one person only.</p>
      </div>` : ""}
      <p class="small">${multiTicket ? "Your tickets are" : "Your ticket is"} also attached to this email as ${multiTicket ? "images" : "an image"}${calendar ? ", with a calendar file" : ""}. ${multiTicket ? "They work" : "It works"} offline, on screen or printed.</p>
      ${ctaBlock}
      <div class="help">
        ${opts.replyTo ? `<div>Questions about the event? Reply to this email to reach the organiser.</div>` : ""}
        <div>Problem with your ticket? Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</div>
      </div>
    </div>
    <div class="footer">
      Powered by WoCo · Decentralised event ticketing on Ethereum Swarm
      ${companyFooterHtml(c.muted)}
    </div>
  </div>
</body>
</html>`;
}

/** The plain-text part: the same facts and links, for text-only clients and spam filters. */
export function buildTicketText(opts: TicketEmailOpts): string {
  const { eventTitle, eventDate, eventEndDate, eventLocation, seriesName, tickets: tix } = opts;
  const display: TicketDisplay = {
    title: eventTitle, date: eventDate, location: eventLocation, series: seriesName,
    image: opts.imageHash, gateway: imageGatewayIndex(opts.imageGateway),
  };
  const when = ticketWhen(eventDate, eventEndDate, "long");
  const multi = tix.length > 1;
  const lines = [`You're going: ${eventTitle}`];
  if (when.day) lines.push(`When: ${when.day}${when.time ? `, ${when.time}` : ""}`);
  if (eventLocation) lines.push(`Where: ${eventLocation}`);
  lines.push("");
  tix.forEach(({ qrContent }, i) => {
    const label = multi ? `Ticket ${i + 1} of ${tix.length}` : "Your ticket";
    const url = ticketUrl(qrContent, display);
    lines.push(`${label}${seriesName ? ` (${seriesName})` : ""}${url ? `: ${url}` : ""}`);
  });
  if (multi) lines.push("", "Going with friends? Send each person their own ticket. Every ticket lets one person in and the first scan wins.");
  lines.push("", `Your ticket${multi ? "s are" : " is"} also attached to this email.`);
  if (opts.replyTo) lines.push("Questions about the event? Reply to this email to reach the organiser.");
  lines.push(`Problem with your ticket? Email ${SUPPORT_EMAIL}.`);
  return lines.join("\n") + "\n" + companyFooterText();
}

/** Inline id of the event photo at the top of the email. */
export const HERO_CID = "woco-hero";
/** Ticket images above this, all together, are re-drawn without the photo. */
export const CARD_BUDGET_BYTES = 8 * 1024 * 1024;

const PHOTO_EXT: Record<EventPhoto["mime"], string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif" };

export interface TicketAttachmentDeps {
  fetchPhoto: typeof fetchEventPhoto;
  renderCard: typeof renderTicketCardPng;
}

/** Everything the ticket email attaches, and whether the photo made it in.
 *  Never throws: each part that fails is left out, and the email still goes. */
export async function buildTicketAttachments(
  opts: TicketEmailOpts,
  deps: TicketAttachmentDeps = { fetchPhoto: fetchEventPhoto, renderCard: renderTicketCardPng },
): Promise<{ attachments: OutboundAttachment[]; hero: boolean }> {
  const { eventTitle, eventDate, eventEndDate, eventLocation, seriesName, tickets: tix, palette } = opts;
  const photo = await deps.fetchPhoto(opts.imageHash, imageGatewayIndex(opts.imageGateway)).catch(() => null);
  const renderCards = (withPhoto: boolean) =>
    Promise.all(
      tix.map(({ qrContent }, i) =>
        deps.renderCard({
          eventTitle,
          eventDate,
          eventEndDate,
          eventLocation,
          seriesName,
          position: tix.length > 1 ? { n: i + 1, of: tix.length } : null,
          qrContent,
          palette,
          photo: withPhoto ? photo : null,
        }),
      ),
    );
  let cards: Buffer[] = [];
  try {
    cards = await renderCards(!!photo);
    if (photo && cards.reduce((n, b) => n + b.length, 0) > CARD_BUDGET_BYTES) cards = await renderCards(false);
  } catch (err) {
    // The ticket pages carry every ticket; an email without images still delivers them.
    console.error("[tickets] ticket images failed - sending without them:", err);
    cards = [];
  }

  let ics: string | null = null;
  try {
    ics = eventIcs({ eventId: opts.eventId ?? "", title: eventTitle, startIso: eventDate, endIso: eventEndDate, location: eventLocation });
  } catch {
    ics = null;
  }

  return {
    hero: !!photo,
    attachments: [
      ...(photo ? [{ filename: `event.${PHOTO_EXT[photo.mime]}`, content: photo.bytes, contentId: HERO_CID, contentType: photo.mime }] : []),
      ...cards.map((png, i) => ({
        filename: tix.length > 1 ? `ticket-${i + 1}-of-${tix.length}.png` : "ticket.png",
        content: png,
        contentType: "image/png",
      })),
      ...(ics ? [{ filename: "event.ics", content: Buffer.from(ics, "utf-8"), contentType: "text/calendar; charset=utf-8; method=PUBLISH" }] : []),
    ],
  };
}

/** Send ticket confirmation email(s). Exported for use by the Stripe webhook handler.
 *
 * Each ticket is attached as a portrait image (event photo, details and QR -
 * see lib/ticket/render-card.ts) the buyer can save or forward; the email body
 * links each ticket's page. The event photo is embedded once (`cid:`) for the
 * top of the email. Every decoration is optional: if the photo, an image or
 * the calendar file fails, the ticket still goes out - someone paid for it.
 */
export async function sendTicketEmail(opts: TicketEmailOpts): Promise<void> {
  const fromAddress = getFromAddress();
  const { to, eventTitle, tickets: tix } = opts;
  const subject = tix.length > 1 ? `Your ${tix.length} tickets - ${eventTitle}` : `Your ticket - ${eventTitle}`;
  const { attachments, hero } = await buildTicketAttachments(opts);

  await sendEmail(
    {
      from: `"${eventTitle.slice(0, 40)}" <${fromAddress}>`,
      to: [to],
      subject,
      html: buildTicketHtml(opts, { hero }),
      text: buildTicketText(opts),
      attachments,
      // Attendees reply to ticket email expecting the organiser, not a void.
      ...(opts.replyTo ? { replyTo: [opts.replyTo] } : {}),
    },
    {
      priority: "transactional",
      ...(opts.failureContext ? { context: opts.failureContext } : {}),
    },
  );
}
