/**
 * The ticket email goes out from Stripe fulfilment only, to the verified
 * purchase address. A public `POST /api/tickets/send-email` (v1 claim rail)
 * once sent it to any address, with caller-chosen event text and QR content,
 * unauthenticated - a ready-made phishing sender on WoCo's own domain. It had
 * no callers after #207 and was removed on 2026-10-02.
 *
 * SOURCE SCAN: what matters is that no route exists, which is a property of
 * the source. MUTATION: mount anything at /api/tickets, or give
 * routes/tickets.ts a router again, and a case goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const read = (rel: string) => readFileSync(`${SRC}/${rel}`, "utf-8");

test("nothing is mounted at /api/tickets", () => {
  assert.doesNotMatch(read("index.ts"), /app\.route\(\s*"\/api\/tickets"/);
});

test("the ticket email module declares no HTTP route", () => {
  const src = read("routes/tickets.ts");
  assert.doesNotMatch(src, /new Hono\b/, "routes/tickets.ts builds a router again");
  assert.doesNotMatch(src, /\.(get|post|put|patch|delete)\(\s*"/, "routes/tickets.ts registers a route again");
});

test("fulfilment still sends the ticket email", () => {
  assert.match(read("routes/tickets.ts"), /export async function sendTicketEmail\(/);
  assert.match(read("lib/stripe/fulfilment-live.ts"), /import \{ sendTicketEmail \} from "\.\.\/\.\.\/routes\/tickets\.js";/);
});
