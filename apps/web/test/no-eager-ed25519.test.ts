/**
 * ed25519 must not be in the eager bundle (#518).
 *
 * No launch path signs with the curve. A ticket is signed by its per-purchase
 * secp256k1 BURNER key and verified against the on-chain `slotOwner`; editions
 * and manifests are signed by the secp256k1 ISSUING key; feeds are signed by the
 * content-feed signer. The one client that still needs ed25519 is the coaster-
 * credits rail (`woco.credit.v1`), which is out of launch scope — so the curve
 * must be loaded only when a rider actually taps, never on first paint for a
 * visitor who will never sign a ride.
 *
 * `@noble/ed25519` was deleted from the eager graph in three ways at once, and
 * any ONE of them coming back re-eagerises it: a second file importing it, a
 * static import in the file that owns it, or an eager module re-exporting that
 * file. All three are asserted.
 *
 * SOURCE SCAN, deliberately. The property is about the import GRAPH, which a
 * runtime test in Node cannot observe — Node resolves every import the same way
 * whether or not Vite would code-split it. Scanning the source is the instrument
 * that matches the claim.
 *
 * MUTATION: change `await import("@noble/ed25519")` in holder-key.ts to a static
 * import, or import the package anywhere else under src/, and this goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
/** The one file allowed to touch the package at all, relative to src/. */
const OWNER = "lib/credits/holder-key.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|svelte|js)$/.test(name)) out.push(full);
  }
  return out;
}

const FILES = walk(SRC).map((full) => ({
  rel: full.slice(SRC.length + 1),
  text: readFileSync(full, "utf-8"),
}));

test("the scan actually reaches the file it is about", () => {
  // Without this, a rename of holder-key.ts would empty the scan and every
  // assertion below would pass vacuously — the classic way a source ratchet
  // stops guarding anything while staying green.
  const owner = FILES.find((f) => f.rel === OWNER);
  assert.ok(owner, `${OWNER} must exist — the eager-bundle guard is about this file`);
  assert.match(owner.text, /@noble\/ed25519/, "…and it must be the file that loads the curve");
  assert.ok(FILES.length > 200, `the walk found only ${FILES.length} files — it is not reaching src/`);
});

test("exactly one file under src/ names @noble/ed25519", () => {
  const importers = FILES.filter((f) => f.text.includes("@noble/ed25519")).map((f) => f.rel);
  assert.deepEqual(importers, [OWNER]);
});

test("the one importer loads it DYNAMICALLY", () => {
  const { text } = FILES.find((f) => f.rel === OWNER)!;
  assert.match(text, /await import\(\s*["']@noble\/ed25519["']\s*\)/, "must be a dynamic import()");
  // A static `import … from "@noble/ed25519"` at any indentation, in any of the
  // forms esbuild treats as eager. `import(` is excluded by requiring `from`.
  assert.doesNotMatch(
    text,
    /^\s*import\s[^\n]*from\s*["']@noble\/ed25519["']/m,
    "a static import would put the curve back in the eager bundle",
  );
  assert.doesNotMatch(
    text,
    /^\s*import\s*["']@noble\/ed25519["']/m,
    "a bare side-effect import is eager too",
  );
});

test("no eager module re-exports the holder key", () => {
  // `export … from "./holder-key.js"` in a barrel would drag the module — and so
  // the dynamic import's own module record — into whatever imports the barrel.
  // The dynamic import inside it still splits the CURVE, but the wrapper file
  // becomes eager, and the next person to add a static import there sees a file
  // that is already loaded and no reason not to.
  const reexporters = FILES.filter(
    (f) => f.rel !== OWNER && /export\s[^\n]*from\s*["'][^"']*holder-key(\.js)?["']/.test(f.text),
  ).map((f) => f.rel);
  assert.deepEqual(reexporters, []);
});
