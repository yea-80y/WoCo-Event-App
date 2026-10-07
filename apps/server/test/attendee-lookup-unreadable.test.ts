/**
 * #546: the ops lookup answers a data subject. From a ledger it cannot read it
 * must refuse, never answer "no orders".
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

const dir = mkdtempSync(join(tmpdir(), "woco-lookup-unreadable-"));
process.chdir(dir);
mkdirSync(join(dir, ".data"), { recursive: true });
writeFileSync(join(dir, ".data", "attendee-slots.json"), "{ not json");
process.env.EMAIL_HASH_SECRET ??= "0".repeat(64);
process.env.OPS_TOKEN = "t".repeat(40);

const { ops } = await import("../src/routes/ops.js");
const app = new Hono();
app.route("/api/ops", ops);

test("an unreadable ledger refuses the lookup (503) instead of answering 'no orders'", async () => {
  const res = await app.request("/api/ops/attendee-batch/lookup", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${"t".repeat(40)}` },
    body: JSON.stringify({ email: "someone@example.com" }),
  });
  assert.equal(res.status, 503);
});
