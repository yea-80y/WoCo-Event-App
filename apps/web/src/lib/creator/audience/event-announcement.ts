/**
 * Broadcast email bodies, built client-side and posted to /api/marketing/broadcast.
 *
 * Pure and unit-tested because the output is HTML that gets mailed to a real
 * audience: a rendering bug here is visible to every contact an organiser has
 * and cannot be recalled.
 *
 * Email HTML is not web HTML. Outlook renders through Word, so this uses
 * presentation tables and inline styles only — no flexbox, no grid, no
 * stylesheet, no shorthand the Word engine drops. Colours match the WoCo
 * unsubscribe page so the whole chain looks like one sender.
 *
 * Every body MUST end with a document-final `</body></html>`: that is the
 * insertion point the server's compliance footer looks for
 * (`lib/email/marketing-footer.ts` → `withFooter`).
 */

const BG = "#0c0d12";
const SURFACE = "#15161f";
const BORDER = "#23242f";
const TEXT = "#f3f4f8";
const MUTED = "#a0a0b8";
const ACID = "#c7f23a";
const INK = "#0c0d12";

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export interface AnnouncementEvent {
  title: string;
  tagline?: string;
  startDate: string;
  location: string;
  /** Absolute https URL — Swarm gateway. Omitted when the event has no image. */
  imageUrl?: string;
}

export interface EventAnnouncementInput {
  brand: string;
  message: string;
  event: AnnouncementEvent;
  /** Absolute URL of the public event page — the CTA target. */
  eventUrl: string;
}

/** Where the app is publicly reachable, for links that leave the browser. */
const PUBLIC_APP_ORIGIN = "https://woco.eth.limo";

/**
 * Absolute, publicly-resolvable event URL for the CTA.
 *
 * A broadcast composed on a dev server must NOT ship `http://localhost:5173/...`
 * links — they are dead for every recipient — so a local origin falls back to
 * the public one.
 */
export function publicEventUrl(eventId: string, origin: string): string {
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(
    origin.replace(/\/$/, ""),
  );
  const base = isLocal ? PUBLIC_APP_ORIGIN : origin.replace(/\/$/, "");
  return `${base}/event/${encodeURIComponent(eventId)}`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Organiser prose: escaped, then blank lines become paragraphs. */
function messageHtml(message: string): string {
  return escapeHtml(message)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(
      (p) =>
        `<p style="margin:0 0 14px;color:${MUTED};font-size:15px;line-height:1.65">${p.replace(/\n/g, "<br />")}</p>`,
    )
    .join("");
}

/**
 * "Friday 15 August 2026, 8:00 pm". An unparseable date returns "" so the
 * whole line is dropped — a broken date in a launch email is worse than none.
 */
export function formatEventWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(d)
    .replace(" at ", ", ");
}

/**
 * Inbox preview line, invisible in the opened email. Without one, Gmail and
 * Apple Mail scrape whatever text renders first — the small-caps brand row —
 * as the message preview. The trailing &nbsp;&zwnj; padding stops clients
 * that want a longer preview from continuing into the visible body.
 */
function preheaderHtml(text: string): string {
  const t = text.trim().replace(/\s+/g, " ").slice(0, 140);
  if (!t) return "";
  return `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(t)}${"&nbsp;&zwnj;".repeat(24)}</div>`;
}

function shell(inner: string, preheader = ""): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><meta name="color-scheme" content="dark" /></head>
<body style="margin:0;padding:0;background:${BG};">
${preheaderHtml(preheader)}<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${BG};padding:24px 12px;">
<tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:${SURFACE};border:1px solid ${BORDER};border-radius:16px;overflow:hidden;font-family:${FONT};">
${inner}
</table>
</td></tr>
</table>
</body></html>`;
}

/** Small-caps sender line — the organiser brand, at the top of every body. */
function brandRow(brand: string): string {
  return `<tr><td style="padding:22px 28px 0;">
<span style="display:inline-block;width:9px;height:9px;background:${ACID};border-radius:2px;"></span>
<span style="color:${MUTED};font-size:11px;letter-spacing:0.09em;text-transform:uppercase;padding-left:8px;">${escapeHtml(brand)}</span>
</td></tr>`;
}

/**
 * The on-sale announcement: hero image, what/when/where, the organiser's own
 * words, and one unambiguous call to action. This is the shape almost every
 * broadcast takes, so it is a first-class template rather than something an
 * organiser has to assemble out of a plain-text box.
 */
export function buildEventAnnouncementHtml(input: EventAnnouncementInput): string {
  const { brand, message, event, eventUrl } = input;
  const when = formatEventWhen(event.startDate);
  const href = escapeHtml(eventUrl);

  const hero = event.imageUrl
    ? `<tr><td style="padding:0;"><img src="${escapeHtml(event.imageUrl)}" alt="${escapeHtml(event.title)}" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none;text-decoration:none;" /></td></tr>`
    : "";

  const tagline = event.tagline
    ? `<p style="margin:0 0 14px;color:${ACID};font-size:14px;line-height:1.5;">${escapeHtml(event.tagline)}</p>`
    : "";

  // Each detail row is dropped entirely when empty — a stray "When:" with
  // nothing after it reads as a broken template.
  const details = [
    when ? { label: "When", value: when } : null,
    event.location ? { label: "Where", value: event.location } : null,
  ]
    .filter((d): d is { label: string; value: string } => d !== null)
    .map(
      (d) =>
        `<tr><td style="padding:0 0 6px;color:${MUTED};font-size:14px;line-height:1.5;"><span style="color:#6c6d7c;">${d.label}</span>&nbsp;&nbsp;${escapeHtml(d.value)}</td></tr>`,
    )
    .join("");

  // Preview: the curated tagline when there is one, else the organiser's own
  // opening line — both beat the brand row the client would scrape otherwise.
  const preview = event.tagline || message.split("\n")[0] || "";

  return shell(`${hero}
${brandRow(brand)}
<tr><td style="padding:16px 28px 28px;">
<h1 style="margin:0 0 8px;color:${TEXT};font-size:26px;line-height:1.25;letter-spacing:-0.02em;font-weight:700;">${escapeHtml(event.title)}</h1>
${tagline}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px;">${details}</table>
${messageHtml(message)}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 4px;">
<tr><td align="center" bgcolor="${ACID}" style="border-radius:12px;">
<a href="${href}" style="display:inline-block;padding:14px 30px;color:${INK};font-family:${FONT};font-size:15px;font-weight:700;text-decoration:none;border-radius:12px;">Get tickets</a>
</td></tr>
</table>
<p style="margin:14px 0 0;color:#6c6d7c;font-size:12px;line-height:1.5;">Or open <a href="${href}" style="color:#6c6d7c;">${href}</a></p>
</td></tr>`, preview);
}

/** No event attached — the organiser's message on its own. */
export function buildPlainMessageHtml(brand: string, message: string): string {
  return shell(`${brandRow(brand)}
<tr><td style="padding:14px 28px 28px;">
${messageHtml(message)}
</td></tr>`, message.split("\n")[0] ?? "");
}
