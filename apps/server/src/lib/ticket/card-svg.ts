/**
 * The ticket image as SVG, from the shared layout (`@woco/shared/ticket/card`).
 * `render-card.ts` turns it into the PNG the ticket email attaches; the browser
 * draws the same steps on a canvas.
 */

import QRCode from "qrcode";
import type { TicketCardOp } from "@woco/shared/ticket/card";
import type { EventPhoto } from "./event-photo.js";

const FONTS = {
  sans: "'DejaVu Sans', 'Liberation Sans', Helvetica, Arial, sans-serif",
  mono: "'DejaVu Sans Mono', 'Liberation Mono', Menlo, monospace",
};

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** The QR's dark modules as pixel-aligned squares inside a `size` box. */
function qrModules(content: string, size: number): string {
  const qr = QRCode.create(content, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const cell = size / n;
  let rects = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (qr.modules.get(x, y)) {
        rects += `<rect x="${(x * cell).toFixed(3)}" y="${(y * cell).toFixed(3)}" width="${cell.toFixed(3)}" height="${cell.toFixed(3)}"/>`;
      }
    }
  }
  return rects;
}

export function ticketCardSvg(
  ops: TicketCardOp[],
  opts: { width: number; height: number; qrContent: string; photo?: EventPhoto | null },
): string {
  const defs: string[] = [];
  const body: string[] = [];
  let n = 0;
  for (const op of ops) {
    switch (op.kind) {
      case "rect":
        body.push(`<rect x="${op.x}" y="${op.y}" width="${op.w}" height="${op.h}"${op.radius ? ` rx="${op.radius}"` : ""} fill="${escapeXml(op.fill)}"/>`);
        break;
      case "photo":
        if (!opts.photo) break;
        body.push(
          `<image x="${op.x}" y="${op.y}" width="${op.w}" height="${op.h}" preserveAspectRatio="xMidYMid slice" href="data:${opts.photo.mime};base64,${opts.photo.bytes.toString("base64")}"/>`,
        );
        break;
      case "fade": {
        const id = `fade${n++}`;
        const c = escapeXml(op.colour);
        defs.push(`<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c}" stop-opacity="0"/><stop offset="1" stop-color="${c}" stop-opacity="1"/></linearGradient>`);
        body.push(`<rect x="${op.x}" y="${op.y}" width="${op.w}" height="${op.h}" fill="url(#${id})"/>`);
        break;
      }
      case "text":
        body.push(
          `<text x="${op.x}" y="${op.y}" font-family="${FONTS[op.font]}" font-size="${op.size}" font-weight="${op.weight}" fill="${escapeXml(op.colour)}" text-anchor="${op.anchor}"${op.letterSpacing ? ` letter-spacing="${op.letterSpacing}"` : ""}>${escapeXml(op.text)}</text>`,
        );
        break;
      case "dash":
        body.push(`<line x1="${op.x1}" y1="${op.y}" x2="${op.x2}" y2="${op.y}" stroke="${escapeXml(op.colour)}" stroke-width="${op.width}" stroke-dasharray="${op.dash} ${op.gap}"/>`);
        break;
      case "qr": {
        const inner = op.size - op.padding * 2;
        body.push(`<rect x="${op.x}" y="${op.y}" width="${op.size}" height="${op.size}" rx="${op.radius}" fill="#ffffff"/>`);
        body.push(`<g transform="translate(${op.x + op.padding} ${op.y + op.padding})" fill="#0B0B09" shape-rendering="crispEdges">${qrModules(opts.qrContent, inner)}</g>`);
        break;
      }
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${opts.width}" height="${opts.height}" viewBox="0 0 ${opts.width} ${opts.height}">${defs.length ? `<defs>${defs.join("")}</defs>` : ""}${body.join("")}</svg>`;
}
