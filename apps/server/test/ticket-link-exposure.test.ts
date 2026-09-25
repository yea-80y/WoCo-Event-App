/**
 * A ticket link carries a working ticket, so it must carry nothing else and
 * leak nowhere.
 *
 * Found 2026-09-25: the email's "Open ticket page" link put the buyer's name in
 * the query string (`?n=`), where it lands in CDN logs, browser history and the
 * link scanners mail providers run; the page and the PNG then printed "ISSUED TO"
 * straight from that parameter, so anyone holding a link could put any name on a
 * genuine ticket; and /t responses had no Referrer-Policy, because the security
 * headers were mounted on /api and /embed only.
 *
 * The page route needs a chain read to render (verifyTicketSig), so the page and
 * the mount are pinned by source; the link builder is tested directly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ticketUrl } from "../src/routes/tickets.js";

const SRC = new URL("../src/", import.meta.url).pathname;
const read = (p: string) => readFileSync(SRC + p, "utf-8");

const QR = `woco://t/0x${"ab".repeat(32)}/series-1/7/0x${"cd".repeat(65)}`;

test("a ticket link carries no name and no email", () => {
  for (const url of [ticketUrl(QR), ticketUrl(QR, true), ticketUrl(QR, false, "site_abc123")]) {
    assert.ok(url, "the link builder must still produce a link");
    const q = new URL(url!, "https://api.example").searchParams;
    assert.equal(q.get("n"), null, "buyer name must not ride in a ticket URL");
    assert.equal(q.get("e"), null, "buyer email must not ride in a ticket URL");
  }
});

test("the site id is the only query parameter a ticket link keeps", () => {
  const url = ticketUrl(QR, false, "site_abc123")!;
  const q = new URL(url, "https://api.example").searchParams;
  assert.deepEqual([...q.keys()], ["s"]);
});

test("the ticket page reads no name or email from its URL", () => {
  const page = read("routes/ticket-page.ts");
  assert.doesNotMatch(page, /searchParams\.get\(\s*["'`][ne]["'`]\s*\)/, "the page must not print text taken from its URL");
  assert.doesNotMatch(page, /ISSUED TO/, "an unverifiable 'issued to' line is back");
});

test("the ticket page does not copy its whole query string onto the image link", () => {
  const page = read("routes/ticket-page.ts");
  assert.doesNotMatch(page, /c\.req\.url\.slice\(\s*c\.req\.url\.indexOf\(\s*["']\?["']\s*\)\s*\)/);
});

test("ticket pages get the security headers, including no-referrer", () => {
  const index = read("index.ts");
  assert.match(index, /app\.use\(\s*["']\/t\/\*["']\s*,\s*securityHeaders\(\)\s*\)/);
  // Registered before the route, or it never runs for it.
  const mount = index.search(/app\.use\(\s*["']\/t\/\*["']/);
  const route = index.search(/app\.route\(\s*["']\/t["']/);
  assert.ok(mount !== -1 && route !== -1 && mount < route, "the /t headers must be mounted before the /t route");
});
