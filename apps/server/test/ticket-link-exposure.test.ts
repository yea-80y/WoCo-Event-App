/**
 * A ticket link carries a working ticket, so it must reach no server and leak
 * nowhere.
 *
 * History: #688 took the buyer's name out of the old `/t/…/{sig}` link and gave
 * /t a no-referrer policy. That link still put the SIGNATURE in the request path,
 * so it reached our server and every log in front of it. The link now points at
 * a static page on the app origin with the ticket in the URL fragment, which a
 * browser never sends (packages/shared/src/ticket/link.ts), and /t is retired.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ticketUrl } from "../src/routes/tickets.js";
import { ticketPage } from "../src/routes/ticket-page.js";

const SRC = new URL("../src/", import.meta.url).pathname;
const read = (p: string) => readFileSync(SRC + p, "utf-8");

const EVENT = "449ce21d-8503-4dc1-936b-2268b5a8356f";
const SIG = `0x${"cd".repeat(65)}`;
const QR = `woco://t/${EVENT}/series-1/7/${SIG}`;

test("the link opens the static ticket page, with the ticket only in the fragment", () => {
  const url = new URL(ticketUrl(QR, { title: "Rooftop Sessions", location: "Leeds" })!);
  assert.equal(url.pathname, "/ticket.html");
  assert.ok(url.hash.startsWith(`#${EVENT}/series-1/7/${SIG}`), "ticket parts lead the fragment");
  assert.ok(!(url.pathname + url.search).includes(SIG), "the signature must never be in the request line");
  assert.equal(url.search, "", "nothing may ride in the query string, which IS sent");
});

test("a ticket link never carries the buyer's name", () => {
  const src = read("routes/tickets.ts");
  const start = src.indexOf("const display: TicketDisplay = {");
  const block = src.slice(start, src.indexOf("};", start));
  assert.ok(start !== -1, "the display block moved - re-point this test");
  assert.doesNotMatch(block, /buyerName|\bto\b|email/i, "the email must not put the buyer's name or address in the link");
});

test("an over-long title is dropped before any ticket part", () => {
  const url = ticketUrl(QR, { title: "x".repeat(5000), location: "y".repeat(5000), series: "z".repeat(5000) })!;
  assert.ok(url.length <= 1000, `link is ${url.length} chars`);
  assert.ok(new URL(url).hash.startsWith(`#${EVENT}/series-1/7/${SIG}`));
});

test("the retired /t route answers 410 and never echoes the signature", async () => {
  for (const path of [`/${EVENT}/series-1/7/${SIG}`, `/${EVENT}/series-1/7/${SIG}.png`, "/anything"]) {
    const res = await ticketPage.request(path);
    assert.equal(res.status, 410, path);
    const body = await res.text();
    assert.ok(!body.includes(SIG), "the moved page must not repeat what the request carried");
  }
});

test("the /t route still gets the security headers, before the route", () => {
  const index = read("index.ts");
  assert.match(index, /app\.use\(\s*["']\/t\/\*["']\s*,\s*securityHeaders\(\)\s*\)/);
  const mount = index.search(/app\.use\(\s*["']\/t\/\*["']/);
  const route = index.search(/app\.route\(\s*["']\/t["']/);
  assert.ok(mount !== -1 && route !== -1 && mount < route);
});
