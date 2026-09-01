/**
 * Response-header hardening for the API origin (#146).
 *
 * Hand-rolled instead of hono's secureHeaders on purpose: its defaults include
 * `Cross-Origin-Resource-Policy: same-origin`, and /embed/woco-embed.js is loaded
 * as a <script> from organiser pages — a cross-origin no-cors embed that CORP
 * blocks regardless of CORS headers. One wrong default there kills every
 * script-embed on the platform, so this file sets exactly two headers and
 * nothing that can strand a cross-origin consumer.
 *
 * Scope matters as much as content: customDomainProxy streams organiser SITE
 * assets through this origin, and `nosniff` turns a mistyped stylesheet
 * content-type into a dead stylesheet — so mount this on /api/* and /embed/*
 * only, never "*".
 */
import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("Referrer-Policy", "no-referrer");
  };
}

/**
 * The embed frame page's one inline script, extracted so its CSP hash below can
 * never drift from what the page actually serves. Must stay free of request
 * interpolation — a hashed script that varies per request stops matching.
 */
export const FRAME_INLINE_SCRIPT = `
    var widget = document.querySelector('woco-tickets');

    // Forward woco-checkout events (fired just before the Stripe redirect)
    // to the parent page
    widget.addEventListener('woco-checkout', function(e) {
      window.parent.postMessage({ type: 'woco-checkout', detail: e.detail }, '*');
    });

    // Auto-resize: notify parent of height changes
    function notifyResize() {
      var h = widget.getBoundingClientRect().height || document.body.scrollHeight;
      window.parent.postMessage({ type: 'woco-resize', height: Math.ceil(h) }, '*');
    }
    new ResizeObserver(notifyResize).observe(widget);
    setTimeout(notifyResize, 300);
  `;

const frameScriptHash = createHash("sha256").update(FRAME_INLINE_SCRIPT, "utf8").digest("base64");

/**
 * CSP for /embed/frame/:eventId. The page is MEANT to be framed by anyone
 * (frame-ancestors *) — that is its whole job, and it replaces the invalid
 * `X-Frame-Options: ALLOWALL` the route used to send. Everything else starts
 * from 'none': the widget talks only to this origin ('self' — its api-url is
 * events-api) and pulls images from the Swarm gateway. style-src stays
 * 'unsafe-inline' because the widget writes theme-dependent <style> into its
 * shadow root, which the document's policy still governs.
 */
export const FRAME_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  `script-src 'self' 'sha256-${frameScriptHash}'`,
  "style-src 'unsafe-inline'",
  "img-src 'self' https://gateway.woco-net.com data: blob:",
  "connect-src 'self'",
  "frame-ancestors *",
].join("; ");
