/**
 * The ticket image in the browser: the static ticket page's Save and the in-app
 * download draw the shared layout (`@woco/shared/ticket/card`) on a canvas, the
 * same steps the server turns into the emailed PNG.
 *
 * Kept free of app imports: the static ticket page bundles this file on its own,
 * under a CSP that allows no requests beyond the event image.
 */

import { encode } from "uqr";
import {
  TICKET_CARD_HEIGHT,
  TICKET_CARD_WIDTH,
  ticketCardOps,
  type TicketCardInput,
  type TicketCardOp,
} from "@woco/shared/ticket/card";

const FONTS = {
  sans: "'Space Grotesk', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: "'JetBrains Mono', Menlo, Consolas, monospace",
};

/**
 * The first URL that loads as a CORS-clean image, else null. Without CORS the
 * canvas would refuse to export, so a gateway that sends no
 * Access-Control-Allow-Origin is skipped and the card is drawn without a photo.
 * A gateway that does not answer within `timeoutMs` is skipped too: a cold
 * Swarm read can stall, and the Save button waits on this.
 */
export function loadCorsImage(urls: string[], timeoutMs = 5_000): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (i >= urls.length) return resolve(null);
      const img = new Image();
      let settled = false;
      const advance = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        img.onload = img.onerror = null;
        i += 1;
        next();
      };
      const timer = setTimeout(advance, timeoutMs);
      img.crossOrigin = "anonymous";
      img.referrerPolicy = "no-referrer";
      img.onload = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(img);
      };
      img.onerror = advance;
      img.src = urls[i];
    };
    next();
  });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(11,11,9,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function drawOp(ctx: CanvasRenderingContext2D, op: TicketCardOp, qrContent: string, photo: HTMLImageElement | null): void {
  switch (op.kind) {
    case "rect":
      ctx.fillStyle = op.fill;
      if (op.radius) {
        roundRect(ctx, op.x, op.y, op.w, op.h, op.radius);
        ctx.fill();
      } else ctx.fillRect(op.x, op.y, op.w, op.h);
      return;
    case "photo": {
      if (!photo) return;
      const ar = photo.naturalWidth / photo.naturalHeight;
      const target = op.w / op.h;
      let sx = 0, sy = 0, sw = photo.naturalWidth, sh = photo.naturalHeight;
      if (ar > target) {
        sw = sh * target;
        sx = (photo.naturalWidth - sw) / 2;
      } else {
        sh = sw / target;
        sy = (photo.naturalHeight - sh) / 2;
      }
      ctx.drawImage(photo, sx, sy, sw, sh, op.x, op.y, op.w, op.h);
      return;
    }
    case "fade": {
      const g = ctx.createLinearGradient(0, op.y, 0, op.y + op.h);
      g.addColorStop(0, hexToRgba(op.colour, 0));
      g.addColorStop(1, hexToRgba(op.colour, 1));
      ctx.fillStyle = g;
      ctx.fillRect(op.x, op.y, op.w, op.h);
      return;
    }
    case "text": {
      ctx.font = `${op.weight} ${op.size}px ${FONTS[op.font]}`;
      ctx.fillStyle = op.colour;
      ctx.textAlign = op.anchor === "middle" ? "center" : op.anchor === "end" ? "right" : "left";
      ctx.textBaseline = "alphabetic";
      const spaced = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
      if ("letterSpacing" in spaced) spaced.letterSpacing = `${op.letterSpacing ?? 0}px`;
      ctx.fillText(op.text, op.x, op.y);
      if ("letterSpacing" in spaced) spaced.letterSpacing = "0px";
      return;
    }
    case "dash":
      ctx.strokeStyle = op.colour;
      ctx.lineWidth = op.width;
      ctx.setLineDash([op.dash, op.gap]);
      ctx.beginPath();
      ctx.moveTo(op.x1, op.y);
      ctx.lineTo(op.x2, op.y);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    case "qr": {
      ctx.fillStyle = "#ffffff";
      roundRect(ctx, op.x, op.y, op.size, op.size, op.radius);
      ctx.fill();
      const { data } = encode(qrContent, { ecc: "M", border: 0 });
      const n = data.length;
      const inner = op.size - op.padding * 2;
      const cell = inner / n;
      ctx.fillStyle = "#0B0B09";
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          if (data[y][x]) {
            ctx.fillRect(
              Math.floor(op.x + op.padding + x * cell),
              Math.floor(op.y + op.padding + y * cell),
              Math.ceil(cell),
              Math.ceil(cell),
            );
          }
        }
      }
      return;
    }
  }
}

/** The whole card, at the layout's full size. */
export function drawTicketCard(
  input: Omit<TicketCardInput, "hasPhoto">,
  qrContent: string,
  photo: HTMLImageElement | null,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = TICKET_CARD_WIDTH;
  canvas.height = TICKET_CARD_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  for (const op of ticketCardOps({ ...input, hasPhoto: !!photo })) drawOp(ctx, op, qrContent, photo);
  return canvas;
}

/** Hands the browser a PNG download - no request, works offline. */
export function downloadCanvas(canvas: HTMLCanvasElement, filename: string): Promise<void> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) return resolve();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      resolve();
    }, "image/png");
  });
}
