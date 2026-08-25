/**
 * #108 — every authenticated request goes through api/client.ts.
 *
 * Two call sites used to build auth headers themselves and hand-roll fetch, so
 * they kept the pre-#107 behaviour: the server rejects the delegation, a raw
 * error surfaces, and the user stays wedged until they manually sign out and
 * back in. One of them was event publish.
 *
 * `buildAuthHeaders` is no longer exported, so the module system enforces this
 * and a regression is a compile error, not a review miss. This test states the
 * invariant in one place anyway — a compile error says "no exported member",
 * which does not tell the next person WHY the export is not there.
 *
 * A text check, like apps/server/test/data-store-modes.test.ts: the module
 * imports a runes module this tsx-based suite cannot execute.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;
const CLIENT = "lib/api/client.ts";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".svelte") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const FILES = walk(SRC).map((p) => ({ rel: p.slice(SRC.length), text: readFileSync(p, "utf8") }));

test("buildAuthHeaders is not exported", () => {
  const client = FILES.find((f) => f.rel === CLIENT);
  assert.ok(client, "client.ts not found");
  assert.doesNotMatch(
    client!.text,
    /export\s*\{[^}]*\bbuildAuthHeaders\b|export\s+(async\s+)?function\s+buildAuthHeaders/,
    "exporting it reopens the hand-rolled-caller class this closed",
  );
});

test("no file outside client.ts builds auth headers", () => {
  const offenders = FILES.filter((f) => f.rel !== CLIENT && /\bbuildAuthHeaders\b/.test(f.text));
  assert.deepEqual(
    offenders.map((f) => f.rel),
    [],
    "authenticated requests must go through client.ts so they inherit session recovery",
  );
});

test("the streaming caller has a recovering entry point to use", () => {
  // Removing the export is only safe because there is somewhere else to go:
  // createEventStreaming genuinely cannot use authFetch, which consumes the
  // body as JSON.
  const client = FILES.find((f) => f.rel === CLIENT);
  assert.match(client!.text, /export async function authStream\(/);
});
