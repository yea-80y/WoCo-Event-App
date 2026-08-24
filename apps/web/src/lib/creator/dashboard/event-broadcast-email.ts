/**
 * The HTML an event broadcast is sent as.
 *
 * Extracted from `Dashboard.svelte` because this output is MAIL: it leaves the
 * origin, reaches a whole audience and cannot be recalled, so whether it escapes
 * organiser input is a property worth pinning in a test rather than a detail
 * living inside a component.
 *
 * It did not escape (#252). The builder named its local `escaped`, performed
 * only a newline-to-`<br>` substitution, and interpolated the event title raw —
 * a name that asserts an obligation the code never carried, which is how a
 * reviewer concludes escaping is present when it is not.
 *
 * The marketing lane's builder (`../audience/event-announcement.ts`) already
 * escapes every field it interpolates; this brings the event lane to the same
 * standard and reuses its `escapeHtml` so the two cannot drift apart.
 */

import { escapeHtml } from "../audience/event-announcement.js";

/**
 * @param body Organiser prose. Single newlines are meaningful here — the
 *   composer is a plain textarea and organisers line-break deliberately — so
 *   they become `<br>`, unlike the marketing builder's blank-line paragraphs.
 * @param eventTitle Rendered as the heading. Organiser-controlled, and reaches
 *   the same recipients, so it is escaped on the same terms as the body.
 *
 * Escaping runs BEFORE the newline substitution: the other order would escape
 * the `<br>` tags this function itself inserts.
 *
 * The document ends at a final `</body>`, which is the anchor the server's
 * compliance footer inserts against (`lib/email/marketing-footer.ts`
 * `withFooter`). Moving that closing tag silently drops the unsubscribe link
 * and the postal address from every event broadcast.
 */
export function buildEventBroadcastHtml(body: string, eventTitle: string): string {
  const prose = escapeHtml(body).replace(/\n/g, "<br>");
  const title = escapeHtml(eventTitle);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #e0e0e0; background: #1a1a2e; padding: 2rem;">
  <div style="max-width: 600px; margin: 0 auto; background: #16213e; border-radius: 12px; padding: 2rem;">
    <h2 style="color: #fff; margin: 0 0 1rem;">${title}</h2>
    <div style="color: #c0c0c0; line-height: 1.6; font-size: 15px;">${prose}</div>
    <hr style="border: none; border-top: 1px solid #2a2a4a; margin: 2rem 0 1rem;">
    <p style="font-size: 12px; color: #666;">Sent via <a href="https://woco.eth.limo" style="color: #7c6cf0;">WoCo</a></p>
  </div>
</body></html>`;
}
