/**
 * The static ticket page's script (built into dist/ticket.html by
 * vite.ticket.config.ts; the HTML and CSP live in vite-plugins/ticket-page.ts).
 *
 * Everything the page shows comes from the URL fragment, which a browser never
 * sends in a request: the four ticket parts that make the QR, and the display
 * fields the email wrote after them (ticket/link.ts). No WoCo server is involved
 * in showing a ticket, and the page's CSP (`connect-src 'none'`) forbids this
 * script any request at all. The one fetch the page makes is the browser loading
 * the event image, from a content gateway, and only if the link names one.
 *
 * Display fields are written with textContent only, and the QR is built node by
 * node: nothing from the link is ever parsed as markup.
 */
import { encode } from "uqr";
import { parseTicketFragment, TICKET_IMAGE_GATEWAYS } from "@woco/shared/ticket/link";

const INK = "#0c0d12";
const PAPER = "#ffffff";
const SVG_NS = "http://www.w3.org/2000/svg";

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function setText(id: string, text: string | undefined): void {
  const el = byId(id);
  if (!el || !text) return;
  el.textContent = text;
  el.hidden = false;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The QR as SVG, built node by node. */
function qrSvg(payload: string): SVGSVGElement {
  const { data } = encode(payload, { ecc: "M", border: 1 });
  const n = data.length;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${n} ${n}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Ticket QR code");
  const bg = document.createElementNS(SVG_NS, "rect");
  bg.setAttribute("width", String(n));
  bg.setAttribute("height", String(n));
  bg.setAttribute("fill", PAPER);
  svg.appendChild(bg);
  let d = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (data[y][x]) d += `M${x} ${y}h1v1h-1z`;
    }
  }
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", INK);
  svg.appendChild(path);
  return svg;
}

/** Draws the ticket on a canvas and hands the browser a blob: download - no request, works offline. */
function saveImage(payload: string, title: string, label: string): void {
  const { data } = encode(payload, { ecc: "M", border: 2 });
  const n = data.length;
  const scale = 10;
  const pad = 32;
  const qrPx = n * scale;
  const width = qrPx + pad * 2;
  const height = width + 112;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = INK;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (data[y][x]) ctx.fillRect(pad + x * scale, pad + y * scale, scale, scale);
    }
  }

  const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  ctx.textAlign = "center";
  ctx.font = `600 22px ${font}`;
  ctx.fillText(clip(title, 34), width / 2, pad + qrPx + 44);
  ctx.font = `500 16px ${font}`;
  ctx.fillText(`Ticket #${label} · show at the door`, width / 2, pad + qrPx + 78);

  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ticket-${label}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, "image/png");
}

/** The event image, from the gateway the link names, falling back to the other. */
function showImage(hash: string, preferred: number): void {
  const img = byId<HTMLImageElement>("art");
  if (!img) return;
  const order = [preferred, ...TICKET_IMAGE_GATEWAYS.keys()].filter((g, i, all) => all.indexOf(g) === i);
  let attempt = 0;
  img.referrerPolicy = "no-referrer";
  img.onerror = () => {
    attempt += 1;
    if (attempt < order.length) img.src = `${TICKET_IMAGE_GATEWAYS[order[attempt]]}/bytes/${hash}`;
    else img.hidden = true;
  };
  img.onload = () => {
    img.hidden = false;
  };
  img.src = `${TICKET_IMAGE_GATEWAYS[order[0]]}/bytes/${hash}`;
}

function formatDate(iso: string): string | undefined {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function run(): void {
  const parsed = parseTicketFragment(location.hash);
  const qr = byId("qr");
  const save = byId<HTMLButtonElement>("save");
  if (!qr || !save) return;

  if (!parsed) {
    const missing = byId("missing");
    if (missing) missing.hidden = false;
    byId("qr-wrap")?.setAttribute("hidden", "");
    return;
  }

  const { ticket, display } = parsed;
  const label = String(ticket.edition).padStart(3, "0");
  const title = display.title || "Your ticket";

  setText("num", `#${label}`);
  setText("title", title);
  setText("date", display.date ? formatDate(display.date) : undefined);
  setText("loc", display.location);
  setText("series", display.series);
  document.title = `Ticket #${label} - ${title}`;
  if (display.image) showImage(display.image, display.gateway ?? 0);

  // The payload the door scanner reads - identical to the one in the emailed
  // image, so either works at the door.
  const payload = `woco://t/${ticket.eventId}/${ticket.seriesId}/${ticket.edition}/${ticket.sig}`;
  qr.replaceChildren(qrSvg(payload));
  save.hidden = false;
  save.addEventListener("click", () => saveImage(payload, title, label));
}

run();
