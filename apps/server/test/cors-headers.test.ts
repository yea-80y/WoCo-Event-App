/**
 * Every header a cross-origin browser client sends must be in the CORS allow
 * list, or its preflight fails and the request never leaves the browser. The
 * in-process route tests never preflight, so this is the only check that would
 * notice. The door scanner is its own origin (#641: X-Door-Pass + X-Scanner-Device).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { SCANNER_DEVICE_HEADER } from "@woco/shared";
import { CORS_ALLOW_HEADERS, CORS_ALLOW_METHODS, CORS_EXPOSE_HEADERS } from "../src/lib/http/cors.js";

function appWithProductionCors(): Hono {
  const app = new Hono();
  app.use("*", cors({
    origin: (origin) => origin || "*",
    allowMethods: CORS_ALLOW_METHODS,
    allowHeaders: CORS_ALLOW_HEADERS,
    exposeHeaders: CORS_EXPOSE_HEADERS,
  }));
  app.post("/api/checkin/:eventId/claim", (c) => c.json({ ok: true }));
  return app;
}

test("a door scanner's preflight is allowed both headers it sends", async () => {
  const res = await appWithProductionCors().request("/api/checkin/evt/claim", {
    method: "OPTIONS",
    headers: {
      Origin: "https://scan.example",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": `content-type, x-door-pass, ${SCANNER_DEVICE_HEADER.toLowerCase()}`,
    },
  });
  const allowed = (res.headers.get("Access-Control-Allow-Headers") ?? "").toLowerCase().split(",").map((h) => h.trim());
  for (const h of ["content-type", "x-door-pass", SCANNER_DEVICE_HEADER.toLowerCase()]) {
    assert.ok(allowed.includes(h), `${h} missing from Access-Control-Allow-Headers`);
  }
});
