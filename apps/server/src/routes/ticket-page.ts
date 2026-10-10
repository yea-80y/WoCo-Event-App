/**
 * The retired server-rendered ticket page.
 *
 * Tickets are now shown by a static page on the app origin (`/ticket.html`,
 * built by apps/web/vite.ticket.config.ts), with the signature in the URL
 * fragment so it reaches no server at all - see packages/shared/src/ticket/link.ts.
 * The old form put the signature in this route's PATH, where it reached our
 * server and every log in front of it.
 *
 * Anything still arriving here (a link from an email sent before the change)
 * gets a plain explanation and a 410. The handler reads nothing from the path
 * and echoes nothing back: the request has already carried the signature this
 * far, and the least this route can do is not repeat it.
 */

import { Hono } from "hono";
import type { AppEnv } from "../types.js";

const ticketPage = new Hono<AppEnv>();

const MOVED_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><meta name="robots" content="noindex,nofollow" /><title>Ticket link moved</title><style>body{background:#0B0B09;color:#F2EBE0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem;margin:0}.box{max-width:420px;text-align:center;background:#14140F;border:1px solid #2B2A23;border-radius:8px;padding:2rem 1.5rem}h1{font-size:1.25rem;margin:0 0 .75rem}p{color:#8A8478;font-size:.9375rem;line-height:1.5;margin:0}</style></head><body><div class="box"><h1>This ticket link has moved</h1><p>Use the ticket image attached to your ticket email - it works at the door. The link in newer ticket emails opens your ticket directly.</p></div></body></html>`;

ticketPage.all("*", (c) =>
  c.html(MOVED_HTML, 410, { "cache-control": "no-store" }),
);

export { ticketPage };
