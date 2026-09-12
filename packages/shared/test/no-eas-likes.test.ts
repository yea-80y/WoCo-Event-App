/**
 * The EAS likes/follows rail is gone and must not creep back (#475).
 *
 * Likes and follows left the chain: they are `woco.like.v1` / `woco.follow.v1`
 * statements on the user's OWN Swarm feed, counted by an indexer
 * (docs/SWARM_SOCIAL_PLAN.md). The EAS rail that preceded them - a shared schema
 * on Arbitrum Sepolia, a server projection in `.data/likes-index.json`, and a
 * Stylus aggregator for trending - was deleted on 2026-09-12 rather than left
 * standing, because a second, older, differently-counted social graph sitting in
 * the tree is exactly what let the profile page render June's test attestations
 * as live follows for three months.
 *
 * What it does NOT forbid: `apps/web/src/lib/components/likes/`, the home of
 * `LikeButton.svelte`. That button is the SWARM-NATIVE write path (it posts
 * through `api/social.js`) and only its directory name is a leftover, so it is
 * excluded by path here rather than being renamed in the deletion's own commit.
 * The exclusion is deliberately narrow: one directory, stated once.
 *
 * SOURCE SCAN, deliberately. The property is "no module in the tree reaches that
 * rail", which is a fact about the import graph and about which files exist.
 * Nothing observable at runtime can assert the absence of a file.
 *
 * MUTATION: create `packages/shared/src/likes/index.ts`, or import any path whose
 * last-but-one segment or basename is `likes` from outside the excluded
 * directory, and this goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, posix, relative, dirname, basename, extname } from "node:path";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The roots whose import graph must be free of the rail. */
const SRC_ROOTS = [
  "packages/shared/src",
  "apps/web/src",
  "apps/server/src",
];

/**
 * The one `likes`-named location that survives: the Swarm-native LikeButton's
 * directory. Anything resolving inside it is allowed; nothing else is.
 */
const ALLOWED_DIR = "apps/web/src/lib/components/likes";

/** Paths that must not exist at all. */
const MUST_BE_GONE = [
  "packages/shared/src/likes",
  "apps/server/src/lib/likes",
  "apps/web/src/lib/api/likes.ts",
  "apps/server/src/routes/likes.ts",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|svelte|js)$/.test(name)) out.push(full);
  }
  return out;
}

const FILES = SRC_ROOTS.flatMap((r) => walk(join(ROOT, r))).map((full) => ({
  rel: relative(ROOT, full).split("\\").join("/"),
  text: readFileSync(full, "utf-8"),
}));

/** Every module specifier a file names, static or dynamic. */
function specifiers(text: string): string[] {
  const out: string[] = [];
  for (const re of [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /^\s*import\s+["']([^"']+)["']/gm,
  ]) {
    for (const m of text.matchAll(re)) out.push(m[1]!);
  }
  return out;
}

/** Does this repo-relative path name the retired rail? */
function namesTheRail(relPath: string): boolean {
  if (relPath.startsWith(`${ALLOWED_DIR}/`)) return false;
  const stem = basename(relPath, extname(relPath));
  if (stem === "likes") return true;
  return dirname(relPath).split("/").includes("likes");
}

test("the scan actually reaches every source root", () => {
  // Without this, a moved directory would empty the walk and every assertion
  // below would pass vacuously — the classic way a source ratchet stops guarding
  // anything while staying green.
  for (const r of SRC_ROOTS) {
    const n = FILES.filter((f) => f.rel.startsWith(`${r}/`)).length;
    assert.ok(n > 20, `${r} contributed only ${n} files — the walk is not reaching it`);
  }
  assert.ok(FILES.length > 500, `the walk found only ${FILES.length} files in total`);
});

test("the one allowed exception is a real file, not a stale excuse", () => {
  // If LikeButton ever moves or is renamed, ALLOWED_DIR stops describing anything
  // and silently widens into a hole. Fail here instead, so whoever moves it must
  // decide consciously whether the exception still belongs.
  assert.ok(
    existsSync(join(ROOT, ALLOWED_DIR, "LikeButton.svelte")),
    `${ALLOWED_DIR}/LikeButton.svelte is gone — drop the exception instead of keeping it`,
  );
});

test("nothing the rail lived in still exists", () => {
  const present = MUST_BE_GONE.filter((p) => existsSync(join(ROOT, p)));
  assert.deepEqual(present, [], "the EAS likes rail was deleted (#475)");
});

test("no source file imports the retired rail", () => {
  const offences: string[] = [];
  for (const { rel, text } of FILES) {
    for (const spec of specifiers(text)) {
      if (spec.startsWith(".")) {
        // Resolve against the importer so `../likes/LikeButton.svelte` is judged
        // by where it LANDS, not by how it is spelled.
        const landed = posix.normalize(posix.join(posix.dirname(rel), spec));
        if (namesTheRail(landed)) offences.push(`${rel} → ${spec} (${landed})`);
      } else if (/(^|\/)likes(\/|$)/.test(spec) || /\/likes\.(js|ts)$/.test(spec)) {
        // A bare/aliased specifier such as `@woco/shared/likes`.
        offences.push(`${rel} → ${spec}`);
      }
    }
  }
  assert.deepEqual(offences, [], "likes and follows are Swarm-native (lib/social/) — #475");
});

test("the likes chain constants moved to the campaign, not into limbo", () => {
  // The referral campaign (#476) is the last EAS user; it must own the constants
  // it needs, or the deletion has simply broken it.
  const eas = join(ROOT, "packages/shared/src/campaign/eas.ts");
  assert.ok(existsSync(eas), "packages/shared/src/campaign/eas.ts must hold the EAS constants");
  const text = readFileSync(eas, "utf-8");
  for (const sym of ["EAS_ADDRESS", "EAS_CHAIN_ID", "SCHEMA_REGISTRY_ADDRESS"]) {
    assert.match(text, new RegExp(`export const ${sym}\\b`), `${sym} must live here now`);
  }
});
