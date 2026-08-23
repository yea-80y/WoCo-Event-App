/**
 * The API's response-header hardening (#146): nosniff + referrer policy land on
 * every response THROUGH the middleware — including error responses, which are
 * the ones an attacker actually probes — and the embed frame's CSP pins the
 * inline script by hash while staying frameable by anyone (that page's job).
 *
 * NOT covered here: that /embed/frame's template really interpolates
 * FRAME_INLINE_SCRIPT (index.ts boots the full server on import, and this suite
 * has no route-level harness — same gap recorded on #378 for the release route).
 * The pairing is kept honest structurally instead: the constant and the hash
 * live in one module, and the route imports both from it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { securityHeaders, FRAME_CSP, FRAME_INLINE_SCRIPT } from "../src/lib/http/security-headers.js";

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

test("frame CSP: hashed inline script, frameable by anyone, no unsafe script", () => {
  const expected = createHash("sha256").update(FRAME_INLINE_SCRIPT, "utf8").digest("base64");
  assert.ok(FRAME_CSP.includes(`script-src 'self' 'sha256-${expected}'`));
  assert.ok(FRAME_CSP.includes("frame-ancestors *"));
  assert.ok(!/script-src[^;]*unsafe/.test(FRAME_CSP));
  assert.ok(FRAME_CSP.startsWith("default-src 'none'"));
});
