/**
 * The embed's seat map frame and the ticket widget, talking by postMessage
 * (docs/SEATING.md; S3 consult Q3). The map runs full screen in a frame on OUR API
 * origin (one origin, one CSP we write); the widget on the organiser's page keeps
 * holds and checkout. DOM-free, so the contract is tested (test/seatmap-bridge.test.ts).
 *
 * Both sides post only to the other's exact origin and accept only from the other's
 * exact window AND origin: never `*` (a hold id is a bearer token for its release).
 * Every message is versioned and shape-checked on receipt. The widget trusts nothing
 * about money from the frame: `seats` + `planDigest` are the buyer's intent, which
 * the server checks against its own pinned plan when it holds them.
 */

import { RESERVATION_MAX_QTY } from "@woco/shared/event/reservation";
import { MAX_PLAN_SEATS } from "@woco/shared/seating/layout";

export const SEATMAP_BRIDGE_V = 1;

/** Frame -> widget. */
export type FrameMessage =
  | { v: 1; type: "ready" }
  /** Hold these seats (the frame's "Hold" button). */
  | { v: 1; type: "picked"; seats: number[]; planDigest: string }
  /** The buyer closed the map. */
  | { v: 1; type: "cancel" };

/** Widget -> frame. */
export type WidgetMessage =
  /** How many seats one order may have, the widget's per-browser key, and whether it can hold seats yet. */
  | { v: 1; type: "open"; max: number; clientKey: string; canHold: boolean }
  /** The hold was placed. */
  | { v: 1; type: "hold"; expiresAt: string }
  /** The hold was refused: these seats are gone, or nothing could be held. */
  | { v: 1; type: "refused"; seats: number[]; message: string };

const DIGEST_RE = /^0x[0-9a-f]{64}$/;
const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keysAre = (o: Record<string, unknown>, keys: string[]) => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => k.includes(x));
};
const seatList = (v: unknown, max: number): v is number[] =>
  Array.isArray(v) && v.length <= max && v.every((k) => Number.isInteger(k) && k >= 0 && k < MAX_PLAN_SEATS) && new Set(v).size === v.length;
const shortText = (v: unknown): v is string => typeof v === "string" && v.length <= 300;

export function parseFrameMessage(data: unknown, max = RESERVATION_MAX_QTY): FrameMessage | null {
  if (!isRecord(data) || data.v !== SEATMAP_BRIDGE_V) return null;
  switch (data.type) {
    case "ready":
    case "cancel":
      return keysAre(data, ["v", "type"]) ? { v: 1, type: data.type } : null;
    case "picked":
      if (!keysAre(data, ["v", "type", "seats", "planDigest"])) return null;
      if (!seatList(data.seats, max) || data.seats.length === 0) return null;
      if (typeof data.planDigest !== "string" || !DIGEST_RE.test(data.planDigest)) return null;
      return { v: 1, type: "picked", seats: [...data.seats].sort((a, b) => a - b), planDigest: data.planDigest };
    default:
      return null;
  }
}

export function parseWidgetMessage(data: unknown): WidgetMessage | null {
  if (!isRecord(data) || data.v !== SEATMAP_BRIDGE_V) return null;
  switch (data.type) {
    case "open":
      if (!keysAre(data, ["v", "type", "max", "clientKey", "canHold"])) return null;
      if (!Number.isInteger(data.max) || (data.max as number) < 1 || (data.max as number) > RESERVATION_MAX_QTY) return null;
      if (typeof data.clientKey !== "string" || !KEY_RE.test(data.clientKey) || typeof data.canHold !== "boolean") return null;
      return { v: 1, type: "open", max: data.max as number, clientKey: data.clientKey, canHold: data.canHold };
    case "hold":
      if (!keysAre(data, ["v", "type", "expiresAt"]) || typeof data.expiresAt !== "string" || Number.isNaN(Date.parse(data.expiresAt))) return null;
      return { v: 1, type: "hold", expiresAt: data.expiresAt };
    case "refused":
      if (!keysAre(data, ["v", "type", "seats", "message"]) || !seatList(data.seats, RESERVATION_MAX_QTY) || !shortText(data.message)) return null;
      return { v: 1, type: "refused", seats: data.seats, message: data.message };
    default:
      return null;
  }
}

/** The widget accepts a message only from its own frame, on the API origin. */
export function fromFrame(e: { source: unknown; origin: string }, frame: unknown, apiOrigin: string): boolean {
  return !!frame && e.source === frame && e.origin === apiOrigin;
}

/** The frame accepts a message only from the page that framed it, on the origin it was told. */
export function fromWidget(e: { source: unknown; origin: string }, parent: unknown, hostOrigin: string): boolean {
  return !!parent && e.source === parent && e.origin === hostOrigin;
}

/** An http(s) origin, or null. What the widget tells the frame its page is. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** The frame's address: our API's seat map page, told the widget's origin and theme. */
export function seatmapFrameUrl(apiUrl: string, eventId: string, seriesId: string, hostOrigin: string, theme: "dark" | "light"): string {
  const base = apiUrl.replace(/\/+$/, "");
  const q = new URLSearchParams({ host: hostOrigin, theme });
  return `${base}/embed/seatmap/${encodeURIComponent(eventId)}/${encodeURIComponent(seriesId)}?${q}`;
}
