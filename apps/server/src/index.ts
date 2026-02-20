import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppEnv } from "./types.js";
import { requireAuth } from "./middleware/auth.js";
import { events } from "./routes/events.js";
import { claims } from "./routes/claims.js";
import { orders } from "./routes/orders.js";
import { collection } from "./routes/collection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new Hono<AppEnv>();

// CORS - allow frontend dev server
app.use(
  "*",
  cors({
    origin: (origin) => origin || "*",
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "X-Session-Address",
      "X-Session-Delegation",
    ],
  }),
);

// Health check
app.get("/api/health", (c) => c.json({ ok: true }));

// Serve embed iframe frame page
app.get("/embed/frame/:eventId", (c) => {
  const eventId = c.req.param("eventId").replace(/[^a-zA-Z0-9\-]/g, "");
  const claimMode = (c.req.query("claim-mode") || "both").replace(/[^a-z]/g, "");
  const theme = (c.req.query("theme") || "dark").replace(/[^a-z]/g, "");
  const showImage = c.req.query("show-image") !== "false" ? "true" : "false";
  const showDesc = c.req.query("show-description") !== "false" ? "true" : "false";
  const apiUrl = "https://events-api.woco-net.com";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>* { margin: 0; padding: 0; box-sizing: border-box; } html, body { background: transparent; }</style>
</head>
<body>
  <script src="${apiUrl}/embed/woco-embed.js?v=5"><\/script>
  <woco-tickets
    event-id="${eventId}"
    api-url="${apiUrl}"
    claim-mode="${claimMode}"
    theme="${theme}"
    show-image="${showImage}"
    show-description="${showDesc}"
  ></woco-tickets>
  <script>
    var widget = document.querySelector('woco-tickets');

    // Forward woco-claim events to parent page
    widget.addEventListener('woco-claim', function(e) {
      window.parent.postMessage({ type: 'woco-claim', detail: e.detail }, '*');
    });

    // Auto-resize: notify parent of height changes
    function notifyResize() {
      var h = widget.getBoundingClientRect().height || document.body.scrollHeight;
      window.parent.postMessage({ type: 'woco-resize', height: Math.ceil(h) }, '*');
    }
    new ResizeObserver(notifyResize).observe(widget);
    setTimeout(notifyResize, 300);
  <\/script>
</body>
</html>`;

  c.header("Content-Type", "text/html");
  c.header("X-Frame-Options", "ALLOWALL");
  c.header("Cache-Control", "no-store");
  return c.body(html);
});

// Serve embed widget JS
app.get("/embed/woco-embed.js", (c) => {
  try {
    const embedPath = resolve(__dirname, "../../../packages/embed/dist/woco-embed.js");
    const js = readFileSync(embedPath, "utf-8");
    c.header("Content-Type", "application/javascript");
    c.header("Cache-Control", "public, max-age=3600");
    c.header("Access-Control-Allow-Origin", "*");
    return c.body(js);
  } catch {
    return c.text("Embed widget not built. Run: npm run build:embed", 404);
  }
});

// Authenticated: returns the verified parent address
app.post("/api/auth/whoami", requireAuth, (c) => {
  return c.json({
    ok: true,
    data: {
      parentAddress: c.get("parentAddress"),
      sessionAddress: c.get("sessionAddress"),
    },
  });
});

// Event routes
app.route("/api/events", events);
app.route("/api/events", claims);
app.route("/api/events", orders);

// Collection routes (authenticated)
app.route("/api/collection", collection);

const port = Number(process.env.PORT) || 3001;
console.log(`WoCo server listening on :${port}`);
serve({ fetch: app.fetch, port });
