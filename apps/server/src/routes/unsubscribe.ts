/**
 * Public unsubscribe pages — /u/:token (mounted WITHOUT /api prefix: these
 * URLs ship inside marketing emails, same rationale as /t ticket pages).
 *
 * GET  /u/:token  → confirm page (per-organiser scope + optional "block all")
 * POST /u/:token  → performs suppression. Serves BOTH the human form and
 *                   RFC 8058 one-click POSTs (List-Unsubscribe=One-Click body,
 *                   or empty body) — mailbox providers POST here directly with
 *                   no user interaction, so the default per-organiser scope
 *                   must apply with zero required fields.
 *
 * No auth: possession of a valid HMAC token IS the authorization. Idempotent
 * by construction, so no rate limit is needed. We only ever know the email's
 * HMAC hash — the page must not claim to display the address.
 */

import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { verifyUnsubToken } from "../lib/marketing/unsub-token.js";
import { suppressOrg, suppressGlobal } from "../lib/marketing/suppression-store.js";

const unsubscribe = new Hono<AppEnv>();

function page(title: string, heading: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><meta name="robots" content="noindex" /><title>${title}</title><style>
body{background:#0c0d12;color:#f3f4f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem;margin:0}
.box{max-width:440px;width:100%;background:#15161f;border:1px solid #23242f;border-radius:18px;padding:2rem 1.75rem}
h1{font-size:1.25rem;margin:0 0 0.75rem;letter-spacing:-0.01em}
p{color:#a0a0b8;font-size:0.9375rem;line-height:1.55;margin:0 0 1.25rem}
.mark{display:inline-block;width:10px;height:10px;border-radius:2px;background:#c7f23a;margin-right:0.5rem;transform:rotate(45deg)}
button{width:100%;background:#c7f23a;color:#0c0d12;border:0;border-radius:12px;padding:0.875rem 1rem;font-size:0.9375rem;font-weight:700;cursor:pointer}
button:hover{filter:brightness(1.08)}
label{display:flex;gap:0.65rem;align-items:flex-start;color:#a0a0b8;font-size:0.875rem;line-height:1.45;margin:0 0 1.25rem;cursor:pointer}
input[type=checkbox]{appearance:none;flex:none;width:18px;height:18px;margin-top:1px;border:1.5px solid #3a3b4a;border-radius:5px;background:#0c0d12;cursor:pointer;position:relative}
input[type=checkbox]:checked{background:#c7f23a;border-color:#c7f23a}
input[type=checkbox]:checked::after{content:"";position:absolute;left:5px;top:1.5px;width:4px;height:9px;border:solid #0c0d12;border-width:0 2px 2px 0;transform:rotate(45deg)}
.ok{color:#c7f23a}
small{display:block;color:#5c5d70;font-size:0.75rem;margin-top:1.25rem;line-height:1.5}
</style></head><body><div class="box"><h1><span class="mark"></span>${heading}</h1>${body}</div></body></html>`;
}

function invalidPage(): string {
  return page(
    "Invalid link",
    "This link is invalid",
    `<p>This unsubscribe link could not be verified. It may have been truncated by your email client — try copying the full link from the email.</p>`,
  );
}

unsubscribe.get("/:token", (c) => {
  const verdict = verifyUnsubToken(c.req.param("token"));
  if (!verdict.ok) return c.html(invalidPage(), 404);

  return c.html(
    page(
      "Unsubscribe",
      "Unsubscribe from marketing emails",
      `<p>Stop marketing emails from this organiser to this email address. Ticket confirmations for events you book are not affected.</p>
<form method="post">
<label><input type="checkbox" name="all" value="1" /> Also block <strong>all</strong> marketing email sent via WoCo, from any organiser</label>
<button type="submit">Unsubscribe</button>
</form>
<small>You can resubscribe at any time by asking the organiser to re-add you.</small>`,
    ),
  );
});

unsubscribe.post("/:token", async (c) => {
  const verdict = verifyUnsubToken(c.req.param("token"));
  if (!verdict.ok) return c.html(invalidPage(), 404);

  // Tolerate every body shape: human form, RFC 8058 one-click
  // (List-Unsubscribe=One-Click), and empty bodies from strict clients.
  const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);

  suppressOrg(verdict.payload.h, verdict.payload.o, "unsub");
  const blockedAll = body["all"] === "1" || body["all"] === "on";
  if (blockedAll) suppressGlobal(verdict.payload.h, "unsub_all");

  return c.html(
    page(
      "Unsubscribed",
      `<span class="ok">You're unsubscribed</span>`,
      `<p>${
        blockedAll
          ? "This email address will no longer receive any marketing email sent via WoCo."
          : "This email address will no longer receive marketing emails from this organiser."
      }</p><small>Ticket confirmations for events you book are not affected. It may take a short while for in-flight emails to stop.</small>`,
    ),
  );
});

export { unsubscribe };
