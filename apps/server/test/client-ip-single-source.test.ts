/**
 * One derivation of the rate-limit identity, enforced at the source (#219).
 *
 * This defect has now been fixed three times. #179 found nine call sites deriving
 * client identity independently and disagreeing; #218 converted six of them; #219
 * is the three that were left behind, on the payment-adjacent routes. Each round
 * the code was correct when it merged and drifted afterwards, because nothing
 * stopped the next route from writing a tenth answer.
 *
 * A behavioural test cannot catch that: a route with its own unnormalised
 * derivation still rate-limits, still returns the right status codes, and passes
 * every test anyone would think to write for it. The property that matters is
 * structural — there is exactly one place this decision is made — so it is
 * asserted structurally.
 *
 * If this test fails, the fix is to import `clientIp` from lib/http/client-ip.js,
 * not to add an exemption here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "routes");

function routeFiles(): string[] {
  return readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts"));
}

test("no route derives its own client identity", () => {
  const offenders: string[] = [];
  for (const file of routeFiles()) {
    const src = readFileSync(join(ROUTES_DIR, file), "utf-8");
    // A local definition is how every previous round of this began.
    if (/function\s+clientIp\b/.test(src)) offenders.push(`${file}: defines its own clientIp`);
  }
  assert.deepEqual(offenders, [], `derive it once, in lib/http/client-ip.ts:\n${offenders.join("\n")}`);
});

test("no route reads x-forwarded-for", () => {
  // The edge APPENDS to whatever the client sent, so the first element is
  // caller-authored — reading it is the forgeable path, and it defeats the
  // limiter even where cf-connecting-ip is also consulted. See client-ip.ts for
  // why there is deliberately no fallback to this header at all.
  const offenders: string[] = [];
  for (const file of routeFiles()) {
    const src = readFileSync(join(ROUTES_DIR, file), "utf-8");
    if (/header\(\s*["']x-forwarded-for["']/i.test(src)) {
      offenders.push(`${file}: reads x-forwarded-for`);
    }
  }
  assert.deepEqual(offenders, [], `the first element is caller-supplied:\n${offenders.join("\n")}`);
});

test("the guard is looking at real files", () => {
  // A structural assertion that silently scanned nothing would pass forever.
  const files = routeFiles();
  assert.ok(files.length > 10, `expected the routes directory, found ${files.length} files`);
  assert.ok(files.includes("shops.ts"), "expected shops.ts among the scanned routes");
});
