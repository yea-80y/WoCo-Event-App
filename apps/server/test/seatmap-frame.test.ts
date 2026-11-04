/**
 * The embed's seat map frame (docs/SEATING.md; S3 consult Q3): a page on the API
 * origin, framed by any organiser page, that reads Swarm + the chain itself and
 * talks to exactly one origin. Its CSP names every origin the map needs and nothing
 * else; the page carries nothing from the address unescaped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SEATMAP_FRAME_CSP, FRAME_CSP } from "../src/lib/http/security-headers.js";
import { buildSeatmapPage, seatmapHostOrigin } from "../src/lib/embed/seatmap-page.js";

const directive = (csp: string, name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";

test("seat map CSP: framed by anyone, scripts from this origin only, exactly the map's three origins", () => {
  assert.ok(SEATMAP_FRAME_CSP.startsWith("default-src 'none'"));
  assert.equal(directive(SEATMAP_FRAME_CSP, "script-src"), "script-src 'self'");
  assert.equal(directive(SEATMAP_FRAME_CSP, "connect-src"), "connect-src 'self' https://gateway.woco-net.com https://arb1.arbitrum.io");
  assert.equal(directive(SEATMAP_FRAME_CSP, "worker-src"), "worker-src 'self'");
  assert.equal(directive(SEATMAP_FRAME_CSP, "frame-ancestors"), "frame-ancestors *");
  assert.ok(!/unsafe-eval/.test(SEATMAP_FRAME_CSP));
  // The iframe variant of the widget opens the map inside itself.
  assert.equal(directive(FRAME_CSP, "frame-src"), "frame-src 'self'");
});

test("the page escapes what the address carries and keeps only an http(s) origin as host", () => {
  const html = buildSeatmapPage({
    eventId: `e1"><script>alert(1)</script>`,
    seriesId: "s-1",
    host: "https://venue.example/tickets?x=1",
    theme: "light",
  });
  assert.ok(!html.includes("<script>alert"));
  assert.match(html, /data-event="e1scriptalert1script"/);
  assert.match(html, /data-host="https:\/\/venue\.example"/);
  assert.match(html, /data-theme="light"/);
  assert.match(html, /<script src="\/embed\/woco-seatmap\.js\?v=\d+"><\/script>/);
  assert.equal(seatmapHostOrigin("javascript:alert(1)"), null);
  assert.equal(seatmapHostOrigin("data:text/html,x"), null);
  assert.equal(seatmapHostOrigin(undefined), null);
  assert.match(buildSeatmapPage({ eventId: "e", seriesId: "s", host: "javascript:x" }), /data-host=""/);
  assert.match(buildSeatmapPage({ eventId: "e", seriesId: "s", theme: "neon" }), /data-theme="dark"/);
});

test("routes: the page sends its CSP, the bundle and only the parse worker are served (wiring)", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
  const page = src.slice(src.indexOf('app.get("/embed/seatmap/:eventId/:seriesId"'));
  assert.match(page.slice(0, 800), /Content-Security-Policy", SEATMAP_FRAME_CSP/);
  assert.ok(src.includes('app.get("/embed/woco-seatmap.js"'));
  const assets = src.slice(src.indexOf('app.get("/embed/assets/:file"'));
  assert.match(assets.slice(0, 400), /\/\^parse-worker-\[A-Za-z0-9_-\]\{4,32\}\\\.js\$\/\.test\(file\)/);
});
