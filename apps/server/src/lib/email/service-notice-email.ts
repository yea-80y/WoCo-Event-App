/**
 * The HTML of a service notice — composed HERE, on the server, from a fixed
 * category and the organiser's plain-text note (#60 item 1).
 *
 * Every other broadcast accepts `htmlBody` built in the organiser's browser.
 * This one does not, and that is the point: a service notice is the only
 * message permitted to reach someone who unsubscribed, so the organiser must
 * not control the frame around it. If they supplied the HTML they could style
 * the platform's disclosure to nothing, or wrap a promotion in it.
 *
 * The alternative considered and rejected was injecting a disclosure line into
 * organiser-supplied HTML. It needs a reliable anchor in a document the sender
 * wrote, which is the same class of problem as the compliance footer's
 * document-final `</body>` rule — and unlike the footer, this text is the thing
 * justifying the crossing, so "usually inserted in the right place" is not a
 * good enough guarantee.
 *
 * The organiser supplies prose and nothing else. It is escaped, and its
 * newlines become paragraph breaks; no markup of theirs survives.
 */

import { escapeHtml } from "./marketing-footer.js";
import { serviceNoticeDisclosure, type ServiceNoticeType } from "@woco/shared";

const BG = "#0c0d12";
const CARD = "#15161f";
const TEXT = "#f3f4f8";
const MUTED = "#a0a0b8";
const BORDER = "#23242f";
const ACID = "#c7f23a";

/** Organiser prose → escaped paragraphs. Blank lines separate; single newlines break. */
function noteHtml(note: string): string {
  return escapeHtml(note)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(
      (p) =>
        `<p style="margin:0 0 14px;color:${MUTED};font-size:15px;line-height:1.6;">${p.replace(/\n/g, "<br>")}</p>`,
    )
    .join("\n");
}

/**
 * @param heading Platform-composed, from the notice type — see
 *   `serviceNoticeSubject`. Passed in rather than recomputed so the subject a
 *   recipient sees in their inbox and the heading they see on opening cannot
 *   drift apart.
 *
 * Ends at a single document-final `</body>`: the compliance footer inserts
 * there (`marketing-footer.ts` `withFooter`). Service notices keep the footer
 * and the one-click unsubscribe like any other send — the link governs
 * marketing, and re-marking an already-marked address is idempotent.
 */
export function buildServiceNoticeHtml(input: {
  type: ServiceNoticeType;
  eventTitle: string;
  heading: string;
  note: string;
}): string {
  const disclosure = escapeHtml(serviceNoticeDisclosure(input.eventTitle));
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${BG};">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${BG};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:${CARD};border:1px solid ${BORDER};border-radius:18px;">
<tr><td style="padding:26px 28px 0;">
<div style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${ACID};transform:rotate(45deg);"></div>
<h1 style="margin:14px 0 16px;color:${TEXT};font-size:24px;line-height:1.25;letter-spacing:-0.02em;font-weight:700;">${escapeHtml(input.heading)}</h1>
<div style="margin:0 0 18px;padding:12px 14px;background:${BG};border:1px solid ${BORDER};border-radius:10px;color:${MUTED};font-size:13px;line-height:1.55;">${disclosure}</div>
</td></tr>
<tr><td style="padding:0 28px 26px;">
${noteHtml(input.note)}
</td></tr>
</table></td></tr></table>
</body></html>`;
}
