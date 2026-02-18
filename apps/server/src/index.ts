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
