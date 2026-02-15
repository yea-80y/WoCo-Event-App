import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { requireAuth } from "./middleware/auth.js";

const app = new Hono();

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

const port = Number(process.env.PORT) || 3001;
console.log(`WoCo server listening on :${port}`);
serve({ fetch: app.fetch, port });
