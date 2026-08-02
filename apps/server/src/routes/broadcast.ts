/**
 * `POST /api/events/:id/broadcast` — RETIRED.
 *
 * Attendee broadcasts now go through the background queue at
 * `/api/broadcasts/jobs` (`kind: "event"`). Everything this route did — event
 * ownership, per-recipient attendee-membership proof, the 5/hour window, and
 * the compliance path in `sendMarketingBatch` — moved there unchanged. What did
 * not move is sending inside the HTTP request, which is the entire point: at
 * the account send rate a broadcast large enough to matter cannot finish before
 * Cloudflare's origin timeout, and the organiser saw a bare 524 with no idea how
 * many people had been mailed.
 *
 * Kept as an explicit 410 rather than deleted. Hono's default 404 returns plain
 * text, which the frontend's `authPost` tries to `resp.json()` and reports as
 * "Unexpected non-whitespace character at position 4" — a stale tab would show a
 * parser error where it should show "reload the page".
 */

import { Hono } from "hono";
import type { AppEnv } from "../types.js";

const broadcast = new Hono<AppEnv>();

broadcast.post("/:id/broadcast", (c) =>
  c.json(
    {
      ok: false,
      error:
        "This page is out of date — reload it. Attendee broadcasts now send in the " +
        "background, so a large one no longer times out.",
      code: "BROADCAST_ENDPOINT_RETIRED",
    },
    410,
  ),
);

export { broadcast };
