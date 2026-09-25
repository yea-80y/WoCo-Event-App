/**
 * The emailed ticket link, one definition for its three users: the server that
 * writes it into the ticket email, the static ticket page that reads it, and the
 * door scanner that accepts a pasted one.
 *
 *   {appBase}/ticket.html#{eventId}/{seriesId}/{edition}/{sig}?t=…&d=…&l=…&n=…&i=…&g=…
 *
 * EVERYTHING after `#` is the fragment, which a browser never sends in a
 * request - so the signature that makes the ticket valid reaches no server, CDN
 * log or mail link scanner that fetches the page. The page is a static file on
 * Swarm; no WoCo server is involved in showing a ticket at all.
 *
 * The display fields after `?` (title, date, location, series name, image) are
 * NOT authenticated: whoever holds a link can edit them, exactly as they could
 * edit a screenshot. The door decides by the QR alone. The page must present
 * them as the ticket's details, never as proof of anything, and a later check
 * against the organiser's signed event data is what can upgrade them.
 */

import type { TicketQr } from "../checkin/types.js";

/** Path of the static ticket page inside the frontend collection. */
export const TICKET_PAGE_PATH = "/ticket.html";

/** The first two content gateways the page may load an event image from. Index
 *  into this list travels in the link as `g`, so the link names no host. */
export const TICKET_IMAGE_GATEWAYS = [
  "https://gateway.woco-net.com",
  "https://gateway.etherna.io",
] as const;

/** Ceiling on the whole link. Display fields are dropped to fit it; the four
 *  ticket parts never are. Mail clients' own limits are unknown, so stay short. */
export const TICKET_LINK_MAX_CHARS = 1000;

const SIG_RE = /^0x[0-9a-fA-F]{130}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
/** An all-zero reference is how an event with no image is stored - not an image. */
const isImageRef = (h: string): boolean => HASH_RE.test(h) && !/^0+$/.test(h);

export interface TicketDisplay {
  /** Event title. */
  title?: string;
  /** Event start, ISO 8601 - formatted by the page in the viewer's locale. */
  date?: string;
  location?: string;
  /** Ticket type name. */
  series?: string;
  /** Swarm reference of the event image (64 hex). */
  image?: string;
  /** Index into TICKET_IMAGE_GATEWAYS the image is stored on. */
  gateway?: number;
}

/** Per-field caps, applied before the length ceiling. */
const CAPS: Record<"title" | "location" | "series", number> = { title: 80, location: 80, series: 40 };

/** Order display fields are given up in when the link runs long: least useful first. */
const DROP_ORDER: Array<keyof TicketDisplay> = ["series", "location", "date", "image", "title"];

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function displayQuery(d: TicketDisplay): string {
  const q = new URLSearchParams();
  if (d.title) q.set("t", clip(d.title, CAPS.title));
  if (d.date) q.set("d", d.date);
  if (d.location) q.set("l", clip(d.location, CAPS.location));
  if (d.series) q.set("n", clip(d.series, CAPS.series));
  if (d.image && isImageRef(d.image)) {
    q.set("i", d.image);
    if (d.gateway !== undefined && d.gateway > 0 && d.gateway < TICKET_IMAGE_GATEWAYS.length) {
      q.set("g", String(d.gateway));
    }
  }
  return q.toString();
}

/**
 * Build the emailed link. `appBase` is the canonical app origin (no trailing
 * slash), e.g. https://woco.eth.limo.
 */
export function buildTicketLink(appBase: string, ticket: TicketQr, display: TicketDisplay = {}): string {
  const base = `${appBase.replace(/\/$/, "")}${TICKET_PAGE_PATH}#${ticket.eventId}/${encodeURIComponent(ticket.seriesId)}/${ticket.edition}/${ticket.sig}`;
  const d: TicketDisplay = { ...display };
  for (;;) {
    const q = displayQuery(d);
    const link = q ? `${base}?${q}` : base;
    if (link.length <= TICKET_LINK_MAX_CHARS) return link;
    const next = DROP_ORDER.find((k) => d[k] !== undefined);
    if (!next) return base;
    delete d[next];
  }
}

/**
 * Read a link's fragment (with or without the leading `#`). Returns null unless
 * all four ticket parts are present and well-formed; display fields are best
 * effort and never make a ticket unreadable.
 */
export function parseTicketFragment(hash: string): { ticket: TicketQr; display: TicketDisplay } | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const q = raw.indexOf("?");
  const head = q === -1 ? raw : raw.slice(0, q);
  const parts = head.split("/");
  if (parts.length !== 4) return null;

  const [eventId, seriesPart, editionStr, sig] = parts;
  let seriesId: string;
  try {
    seriesId = decodeURIComponent(seriesPart);
  } catch {
    return null;
  }
  const edition = Number(editionStr);
  if (!eventId || !seriesId || !Number.isInteger(edition) || edition < 1 || !SIG_RE.test(sig)) return null;

  const display: TicketDisplay = {};
  if (q !== -1) {
    const p = new URLSearchParams(raw.slice(q + 1));
    const t = p.get("t");
    const d = p.get("d");
    const l = p.get("l");
    const n = p.get("n");
    const i = p.get("i");
    const g = Number(p.get("g") ?? "0");
    if (t) display.title = clip(t, CAPS.title);
    if (d && !Number.isNaN(Date.parse(d))) display.date = d;
    if (l) display.location = clip(l, CAPS.location);
    if (n) display.series = clip(n, CAPS.series);
    if (i && isImageRef(i)) {
      display.image = i;
      display.gateway = Number.isInteger(g) && g >= 0 && g < TICKET_IMAGE_GATEWAYS.length ? g : 0;
    }
  }
  return { ticket: { eventId, seriesId, edition, sig }, display };
}
