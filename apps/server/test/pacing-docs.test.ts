/**
 * The legal inventory describes what the platform holds, and #619 changed it:
 * recipients of a paced send are held for days, under a per-job key. A doc that
 * drifted from the code would state something untrue to a regulator, so the
 * load-bearing facts are pinned to the constants they describe.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PACING_MAX_HOLD_MS } from "@woco/shared";

const doc = readFileSync(fileURLToPath(new URL("../../../docs/legal/DATA_INVENTORY.md", import.meta.url)), "utf-8");
const row = (store: string) => doc.split("\n").find((l) => l.startsWith(`| \`${store}`)) ?? "";

test("the chunk store row states the per-job key and the 7-day ceiling the code enforces", () => {
  assert.equal(PACING_MAX_HOLD_MS, 7 * 24 * 60 * 60_000, "if this moves, the inventory's '7 days' must move with it");
  const chunks = row("broadcast-chunks/*.bin");
  assert.match(chunks, /per job/);
  assert.match(chunks, /7 days/);
});

test("the pacing store and both new tags are declared", () => {
  assert.ok(row("sender-pacing/{sender}.json").length > 0);
  assert.ok(row("woco_ctx_job").length > 0);
  assert.ok(row("woco_ctx_batch").length > 0);
});
