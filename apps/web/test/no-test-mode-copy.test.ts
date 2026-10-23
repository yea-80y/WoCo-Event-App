/**
 * Card payments are live: no page may tell a buyer or organiser that payments
 * are a test, show a Stripe test card, or call the platform pre-launch.
 * SOURCE SCAN over every component and the embed, since that copy is markup.
 *
 * MUTATION: put "4242 4242 4242 4242", "test mode", "Stripe sandbox" or
 * "PRE-LAUNCH" in any .svelte file or in the embed source, and the case below
 * goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_SRC = fileURLToPath(new URL("../src", import.meta.url));
const EMBED_SRC = fileURLToPath(new URL("../../../packages/embed/src", import.meta.url));

// Word-bounded so "latest keys" or a #424242 grey never trips it; `sandbox` is
// Stripe's name for test mode, but an iframe's sandbox="..." attribute is not copy.
const TEST_COPY =
  /4242[\s-]?4242|4000[\s-]?0082|\btest[\s-]mode\b|\btest[\s-]cards?\b|\buse test data\b|\bpre-?launch\b|\bsandbox\b(?!\s*=)|\bpk_test_|\btest keys?\b/i;

function files(dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p, keep) : keep(name) ? [p] : [];
  });
}

test("no page mentions Stripe test mode, a test card or pre-launch", () => {
  const scanned = [
    ...files(WEB_SRC, (n) => n.endsWith(".svelte")),
    ...files(EMBED_SRC, (n) => n.endsWith(".ts")),
  ];
  assert.ok(scanned.length > 50, `scanned only ${scanned.length} files; the scan is not seeing the source`);
  const hits = scanned.flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, i) => (TEST_COPY.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [])),
  );
  assert.deepEqual(hits, []);
});
