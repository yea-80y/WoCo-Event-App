/**
 * Standalone ticket page + composite ticket-card PNG.
 *
 *   GET /t/:eventId/:seriesId/:edition/:sig       → server-rendered HTML
 *   GET /t/:eventId/:seriesId/:edition/:sig.png   → composite PNG
 *
 * The HTML page is a single-shot server render with the QR inlined as SVG —
 * no SPA bundle, no client-side routing, no Swarm round-trip on the client.
 * Loads in a few hundred ms even on cold mobile networks, which is the whole
 * point of replacing the old `woco.eth.limo/#/verify?t=…` link.
 *
 * Both endpoints accept optional query params `?n=` (buyer name) and `?e=`
 * (buyer email). These are display-only — the cryptographic guarantee comes
 * from the ed25519 signature in the URL path, not from the displayed text.
 *
 * No auth: possession of the URL is possession of the ticket. Buyers can
 * forward one URL per ticket to a friend in a multi-ticket purchase. This
 * mirrors the existing /verify route.
 */

import { Hono, type Context } from "hono";
import QRCode from "qrcode";
import type { AppEnv } from "../types.js";
import { getEvent } from "../lib/event/service.js";
import { renderTicketCardPng } from "../lib/ticket/render-card.js";

const ticketPage = new Hono<AppEnv>();

interface TicketContext {
  eventId: string;
  seriesId: string;
  edition: number;
  sig: string;
  qrContent: string;
  buyerName?: string;
  buyerEmail?: string;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Strip query params + decode the buyer info from the request. */
function parseContext(c: Context<AppEnv>): TicketContext | null {
  const eventId = c.req.param("eventId");
  const seriesId = c.req.param("seriesId");
  const editionStr = c.req.param("edition");
  // The :sig param is the LAST URL segment and may have a `.png` suffix when
  // hitting the image endpoint — caller is responsible for stripping it
  // before passing to this helper.
  const sig = c.req.param("sig");
  const edition = Number(editionStr);
  if (!eventId || !seriesId || !sig || !Number.isInteger(edition) || edition < 1) return null;

  const url = new URL(c.req.url);
  const buyerName = url.searchParams.get("n") ?? undefined;
  const buyerEmail = url.searchParams.get("e") ?? undefined;

  return {
    eventId,
    seriesId,
    edition,
    sig,
    qrContent: `woco://t/${eventId}/${seriesId}/${edition}/${sig}`,
    buyerName: buyerName?.trim() || undefined,
    buyerEmail: buyerEmail?.trim() || undefined,
  };
}

/** Render the composite ticket-card PNG. Declared BEFORE the HTML route so
 *  the regex constraint takes priority over the catch-all `:sig` segment. */
ticketPage.get("/:eventId/:seriesId/:edition/:sig{.+\\.png}", async (c) => {
  const rawSig = c.req.param("sig");
  const sig = rawSig.endsWith(".png") ? rawSig.slice(0, -4) : rawSig;
  const eventId = c.req.param("eventId");
  const seriesId = c.req.param("seriesId");
  const edition = Number(c.req.param("edition"));
  if (!eventId || !seriesId || !sig || !Number.isInteger(edition) || edition < 1) {
    return c.text("Invalid ticket link", 400);
  }

  const url = new URL(c.req.url);
  const buyerName = url.searchParams.get("n")?.trim() || undefined;
  const buyerEmail = url.searchParams.get("e")?.trim() || undefined;

  let eventTitle = "Event ticket";
  let eventDate: string | undefined;
  let eventLocation: string | undefined;
  try {
    const ev = await getEvent(eventId);
    if (ev) {
      eventTitle = ev.title || eventTitle;
      eventDate = ev.startDate;
      eventLocation = ev.location;
    }
  } catch {
    // non-fatal — render with generic labels
  }

  const png = await renderTicketCardPng({
    eventTitle,
    eventDate,
    eventLocation,
    edition,
    buyerEmail,
    buyerName,
    qrContent: `woco://t/${eventId}/${seriesId}/${edition}/${sig}`,
  });

  // Convert Node Buffer to Uint8Array for the Response BodyInit type.
  return c.body(new Uint8Array(png), 200, {
    "content-type": "image/png",
    "cache-control": "public, max-age=300, s-maxage=300",
  });
});

/** Render the standalone HTML ticket page. */
ticketPage.get("/:eventId/:seriesId/:edition/:sig", async (c) => {
  const ctx = parseContext(c);
  if (!ctx) return c.text("Invalid ticket link", 400);

  // Best-effort event fetch — page still works if Swarm is slow / unreachable.
  let eventTitle = "Event ticket";
  let eventDate: string | undefined;
  let eventLocation: string | undefined;
  let seriesName: string | undefined;
  try {
    const ev = await getEvent(ctx.eventId);
    if (ev) {
      eventTitle = ev.title || eventTitle;
      eventDate = ev.startDate;
      eventLocation = ev.location;
      const series = ev.series.find((s) => s.seriesId === ctx.seriesId);
      seriesName = series?.name;
    }
  } catch {
    // event fetch is non-fatal; fall through to generic labels
  }

  const dateStr = eventDate
    ? new Date(eventDate).toLocaleString("en-GB", {
        weekday: "short", day: "numeric", month: "long", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      })
    : null;
  const editionStr = String(ctx.edition).padStart(3, "0");

  // Inline QR as SVG so the page paints in one round-trip. `qrcode` returns a
  // self-contained <svg> element which we drop in directly.
  const qrSvg = await QRCode.toString(ctx.qrContent, {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#0c0d12", light: "#ffffff" },
  });

  const pngUrl = `${c.req.path}.png${c.req.url.includes("?") ? c.req.url.slice(c.req.url.indexOf("?")) : ""}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <title>Ticket #${editionStr} — ${escHtml(eventTitle)}</title>
  <meta property="og:title" content="${escHtml(eventTitle)} — Ticket #${editionStr}" />
  <meta property="og:image" content="${escHtml(pngUrl)}" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { background: #0c0d12; color: #f3f4f8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; -webkit-font-smoothing: antialiased; min-height: 100vh; }
    .root { min-height: 100vh; padding: 1.25rem 1rem 2.5rem; display: flex; flex-direction: column; align-items: center; }
    .brand { font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.4em; color: #7c6cf0; margin: 0.5rem 0 1.5rem; }
    .card { width: 100%; max-width: 420px; background: #15161f; border: 1px solid #252634; border-radius: 18px; overflow: hidden; }
    .header { padding: 1.5rem 1.5rem 1.25rem; text-align: center; border-bottom: 1px solid #1c1d2a; }
    .pill { display: inline-block; padding: 4px 12px; border-radius: 999px; background: #1c1d2a; border: 1px solid #2c2e40; color: #a298f5; font-size: 0.75rem; font-weight: 600; letter-spacing: 0.18em; margin-bottom: 0.875rem; }
    h1 { font-size: 1.375rem; font-weight: 700; line-height: 1.25; letter-spacing: -0.015em; margin-bottom: 0.5rem; }
    .meta { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8125rem; color: #a0a0b8; }
    .meta-muted { color: #6a6a80; }
    .qr-wrap { padding: 1.5rem; background: #0c0d12; }
    .qr { width: 100%; max-width: 320px; aspect-ratio: 1; margin: 0 auto; padding: 12px; background: #fff; border-radius: 12px; }
    .qr svg { display: block; width: 100%; height: 100%; }
    .qr-cap { margin-top: 0.875rem; text-align: center; font-size: 0.6875rem; font-weight: 600; letter-spacing: 0.18em; color: #6a6a80; }
    .footer { padding: 1.25rem 1.5rem 1.5rem; text-align: center; }
    .footer-label { font-size: 0.6875rem; font-weight: 600; letter-spacing: 0.18em; color: #6a6a80; margin-bottom: 0.375rem; }
    .footer-name { font-size: 1rem; font-weight: 600; color: #eeeff5; word-break: break-word; }
    .footer-email { margin-top: 0.25rem; font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 0.875rem; color: #a0a0b8; word-break: break-all; }
    .actions { width: 100%; max-width: 420px; margin-top: 1rem; display: flex; gap: 0.5rem; }
    .btn { flex: 1; padding: 0.75rem; text-align: center; text-decoration: none; font-size: 0.8125rem; font-weight: 600; border-radius: 10px; transition: background 0.15s; }
    .btn-primary { background: #7c6cf0; color: #fff; }
    .btn-primary:hover { background: #6b5ad8; }
    .btn-ghost { background: transparent; border: 1px solid #252634; color: #a0a0b8; }
    .btn-ghost:hover { background: #15161f; color: #eeeff5; }
    .note { max-width: 420px; margin: 1.25rem auto 0; text-align: center; font-size: 0.6875rem; color: #4a4a60; line-height: 1.5; }
    @media (max-width: 480px) { h1 { font-size: 1.25rem; } }
  </style>
</head>
<body>
  <main class="root">
    <div class="brand">WOCO TICKET</div>
    <article class="card">
      <header class="header">
        <span class="pill">#${editionStr}</span>
        <h1>${escHtml(eventTitle)}</h1>
        <div class="meta">
          ${dateStr ? `<div>${escHtml(dateStr)}</div>` : ""}
          ${eventLocation ? `<div>${escHtml(eventLocation)}</div>` : ""}
          ${seriesName ? `<div class="meta-muted">${escHtml(seriesName)}</div>` : ""}
        </div>
      </header>
      <div class="qr-wrap">
        <div class="qr">${qrSvg}</div>
        <div class="qr-cap">SHOW AT THE DOOR</div>
      </div>
      ${ctx.buyerName || ctx.buyerEmail ? `
      <footer class="footer">
        <div class="footer-label">ISSUED TO</div>
        ${ctx.buyerName ? `<div class="footer-name">${escHtml(ctx.buyerName)}</div>` : ""}
        ${ctx.buyerEmail ? `<div class="footer-email">${escHtml(ctx.buyerEmail)}</div>` : ""}
      </footer>` : ""}
    </article>
    <div class="actions">
      <a href="${escHtml(pngUrl)}" download="ticket-${editionStr}.png" class="btn btn-primary">Save image</a>
      <a href="${escHtml(pngUrl)}" target="_blank" rel="noopener" class="btn btn-ghost">Open PNG</a>
    </div>
    <p class="note">
      Cryptographically signed · Verifies offline.
      Anyone holding this link can use the ticket — keep it private.
    </p>
  </main>
</body>
</html>`;

  return c.html(html, 200, {
    "cache-control": "no-cache, no-store, must-revalidate",
  });
});

export { ticketPage };
