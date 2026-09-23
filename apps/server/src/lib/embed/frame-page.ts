/**
 * The /embed/frame/:eventId page — the same widget, served inside an iframe for
 * sites that cannot run the web component. Built here rather than inline in the
 * route so its escaping and its pairing with the hashed inline script are
 * testable without booting the server.
 */

import { FRAME_INLINE_SCRIPT } from "../http/security-headers.js";
import { escapeHtml } from "../email/marketing-footer.js";

const API_URL = "https://events-api.woco-net.com";

export interface FramePageInputs {
  eventId: string;
  theme?: string;
  showImage?: string;
  showDescription?: string;
  /** The organiser page, as the pasted snippet passes it (#567). */
  page?: string;
}

/**
 * The organiser page the frame sits on, or null. The widget returns buyers there
 * after Stripe and reads the return marker from it. Only an absolute http(s) URL
 * is kept; the checkout route applies its own stricter rule before Stripe sees it.
 */
export function framePageUrl(raw: string | undefined): string | null {
  if (!raw || raw.length > 2048) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

export function buildFramePage(i: FramePageInputs): string {
  const eventId = i.eventId.replace(/[^a-zA-Z0-9\-]/g, "");
  const theme = (i.theme || "dark").replace(/[^a-z]/g, "");
  const showImage = i.showImage !== "false" ? "true" : "false";
  const showDesc = i.showDescription !== "false" ? "true" : "false";
  const page = framePageUrl(i.page);
  const pageAttr = page ? `\n    page-url="${escapeHtml(page)}"` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>* { margin: 0; padding: 0; box-sizing: border-box; } html, body { background: transparent; }</style>
</head>
<body>
  <script src="${API_URL}/embed/woco-embed.js?v=11"></script>
  <woco-tickets
    event-id="${eventId}"
    api-url="${API_URL}"
    theme="${theme}"
    show-image="${showImage}"
    show-description="${showDesc}"${pageAttr}
  ></woco-tickets>
  <script>${FRAME_INLINE_SCRIPT}</script>
</body>
</html>`;
}
