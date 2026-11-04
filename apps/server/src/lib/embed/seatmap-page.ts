/**
 * /embed/seatmap/:eventId/:seriesId - the ticket widget's seat map, full screen in a
 * frame on this origin (docs/SEATING.md; S3 consult Q3). The page is a shell: the
 * map (`woco-seatmap.js`, the shared SeatPicker) reads Swarm and the chain itself
 * and talks to the widget by postMessage, to the one origin `host` names.
 */

import { escapeHtml } from "../email/marketing-footer.js";

/** Bump with a change to woco-seatmap.js's behaviour (Cloudflare keeps it for hours). */
export const SEATMAP_BUNDLE_VERSION = 1;

export interface SeatmapPageInputs {
  eventId: string;
  seriesId: string;
  /** The widget's page origin. Anything but an http(s) origin is dropped: the map then talks to nobody. */
  host?: string;
  theme?: string;
}

/** An http(s) origin, or null. */
export function seatmapHostOrigin(raw: string | undefined): string | null {
  if (!raw || raw.length > 512) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

export function buildSeatmapPage(i: SeatmapPageInputs): string {
  const id = (s: string) => s.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
  const theme = i.theme === "light" ? "light" : "dark";
  const host = seatmapHostOrigin(i.host) ?? "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <meta name="robots" content="noindex" />
  <title>Choose your seats</title>
</head>
<body>
  <div id="seatframe" data-event="${escapeHtml(id(i.eventId))}" data-series="${escapeHtml(id(i.seriesId))}" data-host="${escapeHtml(host)}" data-theme="${theme}"></div>
  <script src="/embed/woco-seatmap.js?v=${SEATMAP_BUNDLE_VERSION}"></script>
</body>
</html>`;
}
