/**
 * The compliance block every marketing email carries, plus the plain-text
 * alternative part. Pure and separately unit-tested: these strings are the
 * difference between lawful bulk mail and a CAN-SPAM / PECR breach, so they
 * do not live inline in the send loop where a refactor can quietly drop them.
 *
 * Every commercial message must carry, without exception:
 *   1. who is sending and why this recipient is receiving it (provenance)
 *   2. a working, no-cost unsubscribe
 *   3. the sender's physical postal address — CAN-SPAM 15 U.S.C. §7704(a)(5)
 *
 * Callers cannot opt out of any of it; see marketing-send.ts.
 */

export interface FooterContext {
  /** Organiser's brand name, as supplied — escaped here, never pre-escaped. */
  displayName: string;
  unsubUrl: string;
  /** Sender's physical postal address, one line. */
  postalAddress: string;
}

/**
 * The display name reaches the footer from organiser input. Without escaping,
 * a 60-char name is enough to hide everything after it — `<div style=display:
 * none>` needs no quotes and is 24 chars — which would swallow the unsubscribe
 * link itself. Escaping here is what makes the footer's visibility an
 * invariant rather than a hope.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function footerHtml(ctx: FooterContext): string {
  const name = escapeHtml(ctx.displayName);
  const address = escapeHtml(ctx.postalAddress);
  const url = escapeHtml(ctx.unsubUrl);
  // The footer is inserted AFTER the body's own centering table (withFooter
  // targets the document-final </body>), so it must bring its own: without
  // this wrapper it renders flush against the viewport edge instead of
  // aligning under the 600px card every WoCo body draws.
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;"><tr><td style="padding:0 12px 24px;">
<div style="margin-top:8px;padding-top:16px;border-top:1px solid #33343f;color:#8a8b9a;font-size:12px;line-height:1.6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
You're receiving this because you opted in to updates from ${name}. Sent via WoCo.<br/>
<a href="${url}" style="color:#8a8b9a">Unsubscribe</a><br/>
<span style="color:#6c6d7c">${address}</span>
</div>
</td></tr></table></td></tr></table>`;
}

/** Same three obligations, for the text/plain alternative part. */
export function footerText(ctx: FooterContext): string {
  return `\n\n---\nYou're receiving this because you opted in to updates from ${ctx.displayName}. Sent via WoCo.\nUnsubscribe: ${ctx.unsubUrl}\n${ctx.postalAddress}\n`;
}

/**
 * Insert the footer just before a document-final </body>, else append.
 *
 * Only a </body> that really ends the document counts — a mid-document one
 * (e.g. inside a display:none div sent straight to the API) must not let a
 * sender tuck the footer out of sight.
 */
export function withFooter(html: string, footer: string): string {
  const m = /<\/body>\s*(<\/html>\s*)?$/i.exec(html);
  if (!m) return html + footer;
  return html.slice(0, m.index) + footer + html.slice(m.index);
}

const BLOCK_TAGS = /<\/?(?:p|div|br|tr|h[1-6]|li|table|blockquote|section|header|footer)\b[^>]*>/gi;

/**
 * Best-effort text/plain alternative. HTML-only mail is scored down by every
 * major spam filter and is unreadable in text-only clients, so a multipart
 * message is table stakes for bulk sending — a rough rendering beats none.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(BLOCK_TAGS, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    // Zero-width entities (preheader padding) have no text-part rendering —
    // decoded they'd be invisible clutter, undecoded they'd be literal "&zwnj;".
    .replace(/&(?:zwnj|zwj|#8203|#847);/gi, "")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    // Ampersand last, or "&amp;lt;" would decode twice into "<".
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
