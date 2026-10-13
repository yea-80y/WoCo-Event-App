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
import { parseTicketFragment, TICKET_IMAGE_GATEWAYS, type TicketDisplay } from "@woco/shared/ticket/link";
import { WOCO_TICKET_COLOURS } from "@woco/shared/ticket/card";
import { downloadCanvas, drawTicketCard, loadCorsImage } from "../lib/ticket-card/draw.js";

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

/** The gateways to try for the event image: the one the link names, then the other. */
function gatewayOrder(preferred: number): number[] {
  return [preferred, ...TICKET_IMAGE_GATEWAYS.keys()].filter((g, i, all) => all.indexOf(g) === i);
}

/** Draws the ticket (the same design as the emailed image) and hands the browser a
 *  blob: download. The photo is included when its gateway allows a canvas to read
 *  it; otherwise the ticket is drawn without it. */
async function saveImage(payload: string, title: string, display: TicketDisplay): Promise<void> {
  const urls = display.image
    ? gatewayOrder(display.gateway ?? 0).map((g) => `${TICKET_IMAGE_GATEWAYS[g]}/bytes/${display.image}`)
    : [];
  const photo = urls.length ? await loadCorsImage(urls) : null;
  const canvas = drawTicketCard(
    { title, startIso: display.date, location: display.location, series: display.series, colours: WOCO_TICKET_COLOURS },
    payload,
    photo,
  );
  await downloadCanvas(canvas, "ticket.png");
}

/** The event image, from the gateway the link names, falling back to the other. */
function showImage(hash: string, preferred: number): void {
  const img = byId<HTMLImageElement>("art");
  if (!img) return;
  const order = gatewayOrder(preferred);
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
  const title = display.title || "Your ticket";

  // The edition is in the link and the QR (the door needs it), never on the
  // page: its sequence would tell the buyer how many have sold.
  setText("title", title);
  setText("date", display.date ? formatDate(display.date) : undefined);
  setText("loc", display.location);
  setText("series", display.series);
  document.title = `${title} - ticket`;
  if (display.image) showImage(display.image, display.gateway ?? 0);

  // The payload the door scanner reads - identical to the one in the emailed
  // image, so either works at the door.
  const payload = `woco://t/${ticket.eventId}/${ticket.seriesId}/${ticket.edition}/${ticket.sig}`;
  qr.replaceChildren(qrSvg(payload));
  save.hidden = false;
  save.addEventListener("click", async () => {
    if (save.disabled) return;
    const label = save.textContent;
    save.disabled = true;
    save.textContent = "Saving…";
    try {
      await saveImage(payload, title, display);
    } finally {
      save.disabled = false;
      save.textContent = label;
    }
  });
}

run();
