/**
 * The static ticket page: one self-contained HTML file with its script inlined
 * and pinned by hash in a meta CSP.
 *
 * ONE FILE, on purpose. The upload patches `<base href>` into index.html only,
 * and a separate script file would load through the slow eth.limo path and sit
 * in the #605 class (relative URLs resolving against a base they were not
 * written for). Inlined, the page has no relative URL at all.
 *
 * The CSP is what makes "the signature never leaves the phone" structural rather
 * than a property of today's code: `connect-src 'none'` forbids every request a
 * script can make, the only script allowed is the one whose hash is computed
 * here from the exact bytes inlined, and images may come only from the two
 * content gateways an event image can live on.
 */
import { createHash } from "node:crypto";
import type { Plugin } from "vite";
import { TICKET_IMAGE_GATEWAYS } from "@woco/shared/ticket/link";

/** A bundle can contain `</script` inside a string, which would end the tag early. */
export function escapeInlineScript(code: string): string {
  // `<\/` is the same string to JavaScript; keep the original case so no string changes.
  return code.replace(/<\/(script)/gi, "<\\/$1");
}

export function scriptHash(inlined: string): string {
  return createHash("sha256").update(inlined, "utf8").digest("base64");
}

export function ticketPageCsp(hash: string): string {
  return [
    "default-src 'none'",
    `script-src 'sha256-${hash}'`,
    "style-src 'unsafe-inline'",
    `img-src ${TICKET_IMAGE_GATEWAYS.join(" ")}`,
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

export function ticketPageHtml(code: string): string {
  const inlined = escapeInlineScript(code);
  const csp = ticketPageCsp(scriptHash(inlined));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<meta name="referrer" content="no-referrer" />
<title>Your ticket - WoCo</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #0B0B09; color: #F2EBE0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; -webkit-font-smoothing: antialiased; min-height: 100vh; }
  [hidden] { display: none !important; }
  .root { min-height: 100vh; padding: 1.25rem 1rem 2.5rem; display: flex; flex-direction: column; align-items: center; }
  .brand { font-family: ui-monospace, 'JetBrains Mono', Menlo, monospace; font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.4em; color: #C7F23A; margin: 0.5rem 0 1.5rem; }
  .card { width: 100%; max-width: 420px; background: #14140F; border: 1px solid #2B2A23; border-radius: 8px; overflow: hidden; }
  .art { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; background: #1D1C17; }
  .header { padding: 1.5rem 1.5rem 1.25rem; text-align: center; border-bottom: 1px solid #2B2A23; }
  .pill { display: inline-block; padding: 4px 12px; border-radius: 2px; background: #0B0B09; border: 1px solid #2B2A23; color: #C7F23A; font-family: ui-monospace, 'JetBrains Mono', Menlo, monospace; font-size: 0.75rem; font-weight: 600; letter-spacing: 0.18em; margin-bottom: 0.875rem; }
  h1 { font-size: 1.375rem; font-weight: 700; line-height: 1.25; letter-spacing: -0.015em; margin-bottom: 0.5rem; overflow-wrap: anywhere; }
  .meta { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8125rem; color: #8A8478; }
  .qr-wrap { padding: 1.5rem; background: #0B0B09; }
  .qr { width: 100%; max-width: 320px; aspect-ratio: 1; margin: 0 auto; padding: 12px; background: #fff; border-radius: 4px; }
  .qr svg { display: block; width: 100%; height: 100%; }
  .qr-cap { margin-top: 0.875rem; text-align: center; font-family: ui-monospace, 'JetBrains Mono', Menlo, monospace; font-size: 0.6875rem; font-weight: 600; letter-spacing: 0.18em; color: #8A8478; }
  .missing { padding: 1.5rem; text-align: center; font-size: 0.9375rem; line-height: 1.5; color: #FF5B2C; }
  .actions { width: 100%; max-width: 420px; margin-top: 1rem; display: flex; }
  .btn { flex: 1; padding: 0.875rem; font: inherit; font-size: 0.875rem; font-weight: 600; border: 0; border-radius: 4px; background: #C7F23A; color: #0B0B09; cursor: pointer; }
  .btn:hover { background: #D6FF45; }
  .note { max-width: 420px; margin: 1.25rem auto 0; text-align: center; font-size: 0.75rem; color: #8A8478; line-height: 1.5; }
</style>
</head>
<body>
<main class="root" id="ticket">
  <div class="brand">WOCO TICKET</div>
  <article class="card">
    <img id="art" class="art" alt="" hidden />
    <header class="header">
      <span class="pill" id="num" hidden></span>
      <h1 id="title">Your ticket</h1>
      <div class="meta">
        <div id="date" hidden></div>
        <div id="loc" hidden></div>
        <div id="series" hidden></div>
      </div>
    </header>
    <div class="qr-wrap" id="qr-wrap">
      <div class="qr" id="qr"></div>
      <div class="qr-cap">SHOW AT THE DOOR</div>
    </div>
    <p class="missing" id="missing" hidden>This link is missing its ticket code. Open it again from your ticket email - the image attached there works at the door too.</p>
  </article>
  <div class="actions"><button type="button" class="btn" id="save" hidden>Save image</button></div>
  <p class="note">Save the image to show it with no signal. Anyone holding this link can use the ticket - keep it private.</p>
  <noscript><p class="note">Turn on JavaScript to show your ticket, or use the image attached to your ticket email.</p></noscript>
</main>
<script>${inlined}</script>
</body>
</html>
`;
}

/**
 * Emits dist/ticket.html from the ticket-page IIFE and drops the JS chunk, so the
 * page is the only file this build adds to the frontend collection.
 */
export function ticketPagePlugin(): Plugin {
  return {
    name: "woco-ticket-page",
    generateBundle(_options, bundle) {
      const entry = Object.entries(bundle).find(([, c]) => c.type === "chunk" && c.isEntry);
      if (!entry || entry[1].type !== "chunk") {
        this.error("ticket page bundle produced no entry chunk - ticket.html would ship without its script");
        return;
      }
      const [fileName, chunk] = entry;
      delete bundle[fileName];
      this.emitFile({ type: "asset", fileName: "ticket.html", source: ticketPageHtml(chunk.code) });
    },
  };
}
