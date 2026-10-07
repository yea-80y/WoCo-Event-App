/**
 * The ticket image: one portrait layout, drawn by the server (the email
 * attachment, SVG -> PNG) and by the browser (the ticket page's Save and the
 * in-app download). Both draw the same list of steps from `ticketCardOps`, so
 * the two can never drift apart.
 *
 * What a buyer sees, and only that: the global ticket number never appears
 * (it would tell anyone holding the image how many have sold). It stays in
 * the QR payload, which is machine data for the door. A group order says
 * "Ticket N of M", the position in THIS order; a single ticket says
 * "Your ticket".
 *
 * Text widths are ESTIMATED from character classes, not measured: the server
 * renderer cannot measure, and one estimate on both sides keeps the wrapping
 * identical. The estimate is deliberately generous so text never overruns.
 */

export const TICKET_CARD_WIDTH = 900;
export const TICKET_CARD_HEIGHT = 1760;

/** Events carry no time zone of their own yet; WoCo launches in the UK. */
export const EVENT_TIME_ZONE = "Europe/London";

export interface TicketCardColours {
  bg: string;
  text: string;
  secondary: string;
  muted: string;
  dim: string;
  accent: string;
  border: string;
}

/** WoCo's own look ("Concrete & Acid"), used when the organiser set no palette. */
export const WOCO_TICKET_COLOURS: TicketCardColours = {
  bg: "#0B0B09",
  text: "#F2EBE0",
  secondary: "#B5AC9D",
  muted: "#8A8478",
  dim: "#55524A",
  accent: "#C7F23A",
  border: "#2B2A23",
};

/** An organiser site palette (`SitePalette`), the fields the card uses. */
export interface TicketPaletteInput {
  bg?: string;
  text?: string;
  muted?: string;
  accent?: string;
  border?: string;
}

export function ticketCardColours(p?: TicketPaletteInput | null): TicketCardColours {
  const d = WOCO_TICKET_COLOURS;
  if (!p) return d;
  return {
    bg: p.bg ?? d.bg,
    text: p.text ?? d.text,
    secondary: p.muted ?? d.secondary,
    muted: p.muted ?? d.muted,
    dim: p.muted ?? d.dim,
    accent: p.accent ?? d.accent,
    border: p.border ?? d.border,
  };
}

export interface TicketCardInput {
  title: string;
  /** ISO instant the event starts. */
  startIso?: string;
  /** ISO instant the event ends. */
  endIso?: string;
  /** One line, as the organiser typed it: "Venue, street, town". */
  location?: string;
  /** The ticket type, e.g. "General admission". */
  series?: string;
  /** Position in this order. Omit, or `of` 1, for a single ticket. */
  position?: { n: number; of: number };
  /** Whether the renderer has the event photo to draw. */
  hasPhoto: boolean;
  colours: TicketCardColours;
}

export type TicketCardFont = "sans" | "mono";

export type TicketCardOp =
  | { kind: "rect"; x: number; y: number; w: number; h: number; fill: string; radius?: number }
  /** The event photo, cover-fitted into the box. */
  | { kind: "photo"; x: number; y: number; w: number; h: number }
  /** A vertical fade from transparent `colour` (top) to solid `colour` (bottom). */
  | { kind: "fade"; x: number; y: number; w: number; h: number; colour: string }
  | {
      kind: "text";
      x: number;
      y: number;
      text: string;
      size: number;
      weight: 400 | 500 | 700;
      colour: string;
      font: TicketCardFont;
      anchor: "start" | "middle" | "end";
      letterSpacing?: number;
    }
  | { kind: "dash"; x1: number; x2: number; y: number; colour: string; width: number; dash: number; gap: number }
  /** A white rounded square holding the QR, `padding` inside it. */
  | { kind: "qr"; x: number; y: number; size: number; padding: number; radius: number };

/** "Ticket 2 of 4" in a group order; "Your ticket" on its own. */
export function ticketPositionLabel(position?: { n: number; of: number }): string {
  if (!position || position.of <= 1) return "Your ticket";
  return `Ticket ${position.n} of ${position.of}`;
}

function validDate(iso?: string): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Sat 14 Nov 2026" and "22:00 - 04:00", in the event's time zone. */
export function ticketWhen(startIso?: string, endIso?: string): { day?: string; time?: string } {
  const start = validDate(startIso);
  if (!start) return {};
  // Assembled from parts: the joined en-GB form puts a comma after the weekday.
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: EVENT_TIME_ZONE,
  }).formatToParts(start);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const day = `${part("weekday")} ${part("day")} ${part("month")} ${part("year")}`;
  const clock = (d: Date) =>
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: EVENT_TIME_ZONE });
  const end = validDate(endIso);
  return { day, time: end && end > start ? `${clock(start)} - ${clock(end)}` : clock(start) };
}

/** "The Old Depot, 12 Example St, Manchester" -> venue + the rest. */
export function splitLocation(location?: string): { venue?: string; rest?: string } {
  const loc = location?.trim();
  if (!loc) return {};
  const i = loc.indexOf(",");
  if (i < 0) return { venue: loc };
  const venue = loc.slice(0, i).trim();
  const rest = loc.slice(i + 1).trim();
  return rest ? { venue, rest } : { venue };
}

/** Estimated advance of one character, in em. Generous on purpose. */
function charEm(ch: string, font: TicketCardFont): number {
  if (font === "mono") return 0.62;
  if (" .,:;'|!il1jtfr()[]".includes(ch)) return 0.34;
  if ("mwMW@".includes(ch)) return 0.92;
  if (/[A-Z]/.test(ch)) return 0.7;
  if (/[0-9]/.test(ch)) return 0.6;
  return 0.58;
}

export function estimateTextWidth(
  text: string,
  size: number,
  font: TicketCardFont = "sans",
  weight = 400,
  letterSpacing = 0,
): number {
  let em = 0;
  for (const ch of text) em += charEm(ch, font);
  return em * size * (weight >= 700 ? 1.06 : 1) + letterSpacing * Math.max(0, [...text].length - 1);
}

/** Cut `text` to fit `max`, ending in an ellipsis when cut. */
export function clipToWidth(text: string, max: number, size: number, font: TicketCardFont, weight = 400): string {
  if (estimateTextWidth(text, size, font, weight) <= max) return text;
  const chars = [...text];
  while (chars.length > 1 && estimateTextWidth(`${chars.join("").trimEnd()}…`, size, font, weight) > max) chars.pop();
  return `${chars.join("").trimEnd()}…`;
}

/** Word-wrap into at most `maxLines`; the last line is clipped. */
export function wrapToWidth(
  text: string,
  max: number,
  size: number,
  font: TicketCardFont,
  weight: number,
  maxLines: number,
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (estimateTextWidth(next, size, font, weight) <= max || !line) {
      line = next;
      continue;
    }
    if (lines.length === maxLines - 1) {
      return [...lines, clipToWidth(`${line} ${words.slice(i).join(" ")}`, max, size, font, weight)];
    }
    lines.push(line);
    line = words[i];
  }
  if (line) lines.push(clipToWidth(line, max, size, font, weight));
  return lines.slice(0, maxLines);
}

const PAD = 56;
const PHOTO_H = 520;
const COL_GAP = 36;
const QR_BOX = 500;

/** Every drawing step of the card, top to bottom. */
export function ticketCardOps(input: TicketCardInput): TicketCardOp[] {
  const W = TICKET_CARD_WIDTH;
  const H = TICKET_CARD_HEIGHT;
  const c = input.colours;
  const inner = W - PAD * 2;
  const colW = (inner - COL_GAP) / 2;
  const col2 = PAD + colW + COL_GAP;
  const ops: TicketCardOp[] = [{ kind: "rect", x: 0, y: 0, w: W, h: H, fill: c.bg }];

  let y: number;
  if (input.hasPhoto) {
    ops.push({ kind: "photo", x: 0, y: 0, w: W, h: PHOTO_H });
    ops.push({ kind: "fade", x: 0, y: PHOTO_H - 240, w: W, h: 240, colour: c.bg });
    y = PHOTO_H + 56;
  } else {
    y = 120;
  }

  for (const line of wrapToWidth(input.title || "Your ticket", inner, 64, "sans", 700, 2)) {
    ops.push({ kind: "text", x: PAD, y, text: line, size: 64, weight: 700, colour: c.text, font: "sans", anchor: "start" });
    y += 70;
  }

  const when = ticketWhen(input.startIso, input.endIso);
  const where = splitLocation(input.location);
  if (when.day || where.venue) {
    y += 12;
    const label = (x: number, text: string) =>
      ops.push({ kind: "text", x, y, text, size: 20, weight: 500, colour: c.muted, font: "mono", anchor: "start", letterSpacing: 2.4 });
    const value = (x: number, dy: number, text: string, size: number, weight: 400 | 500, colour: string) =>
      ops.push({ kind: "text", x, y: y + dy, text: clipToWidth(text, colW, size, "sans", weight), size, weight, colour, font: "sans", anchor: "start" });
    if (when.day) {
      label(PAD, "WHEN");
      value(PAD, 42, when.day, 30, 500, c.text);
      if (when.time) value(PAD, 80, when.time, 28, 400, c.secondary);
    }
    if (where.venue) {
      const x = when.day ? col2 : PAD;
      label(x, "WHERE");
      value(x, 42, where.venue, 30, 500, c.text);
      if (where.rest) value(x, 80, where.rest, 28, 400, c.secondary);
    }
    y += 80;
  }

  y += 64;
  const position = ticketPositionLabel(input.position);
  const positionW = estimateTextWidth(position, 26, "mono", 700);
  if (input.series) {
    ops.push({
      kind: "text", x: PAD, y,
      text: clipToWidth(input.series, inner - positionW - 32, 30, "sans", 500),
      size: 30, weight: 500, colour: c.text, font: "sans", anchor: "start",
    });
  }
  ops.push({
    kind: "text", x: input.series ? W - PAD : PAD, y, text: position,
    size: 26, weight: 700, colour: c.accent, font: "mono", anchor: input.series ? "end" : "start",
  });

  y += 44;
  ops.push({ kind: "dash", x1: 0, x2: W, y, colour: c.border, width: 4, dash: 14, gap: 10 });

  const footerY = H - 44;
  const caption2Y = H - 110;
  const caption1Y = caption2Y - 38;
  const qrTop = y + Math.max(40, (caption1Y - 56 - y - QR_BOX) / 2);
  ops.push({ kind: "qr", x: (W - QR_BOX) / 2, y: qrTop, size: QR_BOX, padding: 24, radius: 28 });
  ops.push({
    kind: "text", x: W / 2, y: caption1Y, text: "One entry per ticket - the first scan gets in.",
    size: 26, weight: 400, colour: c.secondary, font: "sans", anchor: "middle",
  });
  ops.push({
    kind: "text", x: W / 2, y: caption2Y, text: "Show this at the door, on screen or printed.",
    size: 26, weight: 400, colour: c.secondary, font: "sans", anchor: "middle",
  });
  ops.push({ kind: "text", x: PAD, y: footerY, text: "POWERED BY WOCO", size: 20, weight: 500, colour: c.dim, font: "mono", anchor: "start", letterSpacing: 2 });
  ops.push({ kind: "text", x: W - PAD, y: footerY, text: "VERIFIABLE TICKET", size: 20, weight: 500, colour: c.dim, font: "mono", anchor: "end", letterSpacing: 2 });
  return ops;
}
