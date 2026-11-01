/**
 * The API's response-header hardening (#146): nosniff + referrer policy land on
 * every response THROUGH the middleware — including error responses, which are
 * the ones an attacker actually probes — and the embed frame's CSP pins the
 * inline script by hash while staying frameable by anyone (that page's job).
 *
 * That /embed/frame really serves FRAME_INLINE_SCRIPT is pinned in
 * frame-page.test.ts, now that the page is built by lib/embed/frame-page.ts
 * rather than inline in index.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { apiNoStoreByDefault, securityHeaders, FRAME_CSP, FRAME_INLINE_SCRIPT } from "../src/lib/http/security-headers.js";

function app() {
  const a = new Hono();
  a.use("/api/*", securityHeaders());
  a.get("/api/ok", (c) => c.json({ ok: true }));
  a.get("/api/boom", () => {
    throw new Error("boom");
  });
  a.get("/outside", (c) => c.json({ ok: true }));
  return a;
}

test("nosniff + referrer policy set on a normal response", async () => {
  const res = await app().request("/api/ok");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
});

test("headers also land on error responses", async () => {
  const res = await app().request("/api/boom");
  assert.equal(res.status, 500);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("routes outside the mount are untouched", async () => {
  const res = await app().request("/outside");
  assert.equal(res.headers.get("x-content-type-options"), null);
});

// ── no-store by default (#965 follow-up) ────────────────────────────────────
// MUTATION: drop the middleware, overwrite a route's own header, or mount it
// beyond /api, and a case below goes red.

function cacheApp() {
  const a = new Hono();
  a.use("/api/*", apiNoStoreByDefault());
  a.get("/api/orders", (c) => c.json({ orders: [] }));
  a.get("/api/counts", (c) => {
    c.header("Cache-Control", "public, max-age=60");
    return c.json({ n: 1 });
  });
  a.get("/api/boom", () => {
    throw new Error("boom");
  });
  a.get("/embed/woco-embed.js", (c) => c.text("/* bundle */"));
  return a;
}

test("an API response with no header of its own is no-store, errors too", async () => {
  assert.equal((await cacheApp().request("/api/orders")).headers.get("cache-control"), "no-store");
  const boom = await cacheApp().request("/api/boom");
  assert.equal(boom.status, 500);
  assert.equal(boom.headers.get("cache-control"), "no-store");
});

test("a route that sets its own caching keeps it", async () => {
  assert.equal((await cacheApp().request("/api/counts")).headers.get("cache-control"), "public, max-age=60");
});

test("outside /api nothing is added: the embed script stays cacheable", async () => {
  assert.equal((await cacheApp().request("/embed/woco-embed.js")).headers.get("cache-control"), null);
});

test("the server mounts it on /api/* and nowhere else", () => {
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const mounts = [...index.matchAll(/app\.use\(\s*["']([^"']+)["']\s*,\s*apiNoStoreByDefault\(\)\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(mounts, ["/api/*"]);
});

test("frame CSP: hashed inline script, frameable by anyone, no unsafe script", () => {
  const expected = createHash("sha256").update(FRAME_INLINE_SCRIPT, "utf8").digest("base64");
  assert.ok(FRAME_CSP.includes(`script-src 'self' 'sha256-${expected}'`));
  assert.ok(FRAME_CSP.includes("frame-ancestors *"));
  assert.ok(!/script-src[^;]*unsafe/.test(FRAME_CSP));
  assert.ok(FRAME_CSP.startsWith("default-src 'none'"));
});
