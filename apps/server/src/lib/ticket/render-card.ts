/**
 * Composite ticket-card image renderer.
 *
 * Builds a self-contained ticket image (event title, date, edition number,
 * buyer email, embedded QR) so a buyer can save / forward / screenshot a
 * single PNG that has everything needed at the door.
 *
 * Rendered server-side via SVG → PNG (resvg-js). No Cairo or native build
 * deps; the WASM ships in the npm package.
 *
 * The QR is generated via the `qrcode` library as SVG, parsed for its inner
 * <path> shapes, and embedded directly into the layout SVG. We deliberately
 * avoid `image href=""` so resvg doesn't need to resolve external resources.
 */

import { Resvg } from "@resvg/resvg-js";
import QRCode from "qrcode";

export interface TicketCardData {
  /** Full event title, e.g. "Devcon Brussels 2026" */
  eventTitle: string;
  /** ISO datetime — formatted into a friendly date string */
  eventDate?: string;
  /** Optional venue / address line */
  eventLocation?: string;
  /** Edition number (1-indexed). Null when claim is pending an edition. */
  edition: number | null;
  /** Buyer email — shown on the card so door staff can match ID */
  buyerEmail?: string;
  /** Optional buyer name (from Stripe customer details, when present) */
  buyerName?: string;
  /** Full QR payload — `woco://t/{eventId}/{seriesId}/{edition}/{sig}` */
  qrContent: string;
}

const WIDTH = 800;
const HEIGHT = 1100;
const QR_BOX = 460;          // outer white square
const QR_PADDING = 28;       // padding inside the white square
const QR_INNER = QR_BOX - QR_PADDING * 2;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatDate(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const date = d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${date} · ${time}`;
}

/**
 * Truncate `s` to `max` chars, adding ellipsis if truncated.
 * Used to keep long event titles inside their bounding box at the chosen
 * font size — full word-wrap is overkill for the 1-line title slot.
 */
function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

/** Render the QR matrix as an inline SVG <g> of black squares.
 *  We bypass qrcode's SVG output (which uses a single complex path) and
 *  walk the matrix ourselves — this gives us pixel-aligned squares that
 *  resvg renders crisply at any size. */
async function renderQrMatrix(content: string): Promise<{ size: number; modules: string }> {
  const qr = QRCode.create(content, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const cell = QR_INNER / size;
  let rects = "";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (qr.modules.get(x, y)) {
        rects += `<rect x="${(x * cell).toFixed(3)}" y="${(y * cell).toFixed(3)}" width="${cell.toFixed(3)}" height="${cell.toFixed(3)}"/>`;
      }
    }
  }
  return { size, modules: rects };
}

/** Build the SVG markup for the ticket card. Pure string concat — no DOM. */
async function buildSvg(data: TicketCardData): Promise<string> {
  const { eventTitle, eventDate, eventLocation, edition, buyerEmail, buyerName, qrContent } = data;
  const dateStr = formatDate(eventDate);
  const editionStr = edition != null ? `#${String(edition).padStart(3, "0")}` : null;

  const qr = await renderQrMatrix(qrContent);

  // ── Layout coordinates ─────────────────────────────────────────────
  const qrX = (WIDTH - QR_BOX) / 2;
  const qrY = 320;
  const qrInnerX = qrX + QR_PADDING;
  const qrInnerY = qrY + QR_PADDING;

  // ── Header band ────────────────────────────────────────────────────
  // Title clipped to ~26 chars at 36px so it stays on one line.
  const titleClipped = escapeXml(clip(eventTitle, 32));
  const dateLine = dateStr ? escapeXml(dateStr) : "";
  const locationLine = eventLocation ? escapeXml(clip(eventLocation, 42)) : "";

  // ── Buyer footer ───────────────────────────────────────────────────
  const nameLine = buyerName ? escapeXml(clip(buyerName, 32)) : "";
  const emailLine = buyerEmail ? escapeXml(clip(buyerEmail, 36)) : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="'DejaVu Sans', 'Liberation Sans', Helvetica, Arial, sans-serif">
  <!-- Background -->
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#0c0d12"/>
  <!-- Subtle inner border to give the card a defined edge -->
  <rect x="20" y="20" width="${WIDTH - 40}" height="${HEIGHT - 40}" rx="20" fill="#15161f" stroke="#252634" stroke-width="1"/>

  <!-- Brand row -->
  <text x="${WIDTH / 2}" y="92" text-anchor="middle" font-size="14" font-weight="700"
        letter-spacing="6" fill="#7c6cf0">WOCO TICKET</text>

  ${editionStr ? `
  <!-- Edition pill -->
  <g>
    <rect x="${(WIDTH - 130) / 2}" y="116" width="130" height="34" rx="17" fill="#1c1d2a" stroke="#2c2e40"/>
    <text x="${WIDTH / 2}" y="138" text-anchor="middle" font-size="14" font-weight="600"
          letter-spacing="3" fill="#a298f5">${editionStr}</text>
  </g>` : ""}

  <!-- Event title -->
  <text x="${WIDTH / 2}" y="200" text-anchor="middle" font-size="36" font-weight="700"
        fill="#f3f4f8">${titleClipped}</text>

  ${dateLine ? `
  <text x="${WIDTH / 2}" y="240" text-anchor="middle" font-size="16"
        fill="#a0a0b8">${dateLine}</text>` : ""}

  ${locationLine ? `
  <text x="${WIDTH / 2}" y="${dateLine ? 268 : 240}" text-anchor="middle" font-size="14"
        fill="#6a6a80">${locationLine}</text>` : ""}

  <!-- QR card (white surface for max scanner contrast) -->
  <rect x="${qrX}" y="${qrY}" width="${QR_BOX}" height="${QR_BOX}" rx="14" fill="#ffffff"/>
  <g transform="translate(${qrInnerX} ${qrInnerY})" fill="#0c0d12" shape-rendering="crispEdges">
    ${qr.modules}
  </g>

  <!-- Caption under QR -->
  <text x="${WIDTH / 2}" y="${qrY + QR_BOX + 44}" text-anchor="middle" font-size="13"
        letter-spacing="2" fill="#6a6a80" font-weight="600">SHOW AT THE DOOR</text>

  ${nameLine || emailLine ? `
  <!-- Buyer block -->
  <g transform="translate(${WIDTH / 2} ${qrY + QR_BOX + 90})">
    <text text-anchor="middle" font-size="11" letter-spacing="3" font-weight="600"
          fill="#6a6a80">ISSUED TO</text>
    ${nameLine ? `<text y="28" text-anchor="middle" font-size="20" font-weight="600"
                       fill="#eeeff5">${nameLine}</text>` : ""}
    ${emailLine ? `<text y="${nameLine ? 56 : 30}" text-anchor="middle" font-size="${nameLine ? 14 : 17}"
                         fill="${nameLine ? "#a0a0b8" : "#eeeff5"}"
                         font-family="'DejaVu Sans Mono', 'Liberation Mono', monospace">${emailLine}</text>` : ""}
  </g>` : ""}

  <!-- Footer note -->
  <text x="${WIDTH / 2}" y="${HEIGHT - 50}" text-anchor="middle" font-size="11"
        fill="#4a4a60">Cryptographically signed · Verifies offline</text>
</svg>`;
}

/** Render the ticket card to PNG bytes. 800×1100 by default.
 *
 * resvg needs explicit access to fonts to render <text>. We enable system
 * fonts (DejaVu/Liberation/Helvetica are present on every common server
 * distro) and pin the SVG's font-family list so whichever family resolves
 * first wins. `defaultFontFamily` is the final fallback if none of the
 * named families are installed.
 */
export async function renderTicketCardPng(data: TicketCardData): Promise<Buffer> {
  const svg = await buildSvg(data);
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: WIDTH },
    background: "#0c0d12",
    font: {
      loadSystemFonts: true,
      defaultFontFamily: "DejaVu Sans",
      sansSerifFamily: "DejaVu Sans",
      monospaceFamily: "DejaVu Sans Mono",
    },
  });
  return Buffer.from(resvg.render().asPng());
}
