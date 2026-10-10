/**
 * Nothing but the credits rail may seal or open with the retired X25519 box (#642).
 *
 * Orders, contact lists and the recovery escrow moved to the X-Wing v2 box. The
 * old construction survives only in `apps/web/src/lib/credits/legacy-seal.ts`,
 * quarantined for the out-of-launch-scope credits rail. A new use anywhere else
 * would quietly put fresh data back on a scheme a future quantum computer opens.
 *
 * The one other place allowed to NAME the old box is the social participant
 * registry, whose job is to REFUSE sealed payloads of either shape.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SOURCES = ["apps/web/src", "apps/server/src", "packages/shared/src", "packages/embed/src"];
const ALLOWED = new Set([
  "apps/web/src/lib/credits/legacy-seal.ts",
  "apps/web/src/lib/credits/credits.ts",
  "apps/server/src/lib/social/participants.ts",
]);
const LEGACY = /ephemeralPublicKey|\bsealJson\(|\bopenJson\(|\bsealJsonCompressed\b|\bopenJsonAuto\b|legacy-seal/;

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files(full, out);
    else if (/\.(ts|svelte)$/.test(name)) out.push(full);
  }
  return out;
}

const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("the scan reaches every source root", () => {
  for (const root of SOURCES) assert.ok(files(join(ROOT, root)).length > 10, root);
});

test("no source outside the quarantine seals or opens the retired X25519 box", () => {
  const offenders = SOURCES.flatMap((root) => files(join(ROOT, root)))
    .map((f) => ({ rel: f.slice(ROOT.length).replace(/^\/+/, ""), code: stripComments(readFileSync(f, "utf8")) }))
    .filter((f) => LEGACY.test(f.code) && !ALLOWED.has(f.rel))
    .map((f) => f.rel);
  assert.deepEqual(offenders, []);
});
