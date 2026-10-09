/**
 * The site runtime renders organiser links only through `safeHref`, and its own
 * components call no WebAuthn API. This is a SOURCE scan: the built site bundles
 * still carry passkey-account.ts through imports, refused on a name host at run
 * time by `ceremonyRpId()`; a build-output canary waits on #833.
 *
 * MUTATION: put `href={section.ctaHref}` back in HeroSection and the first test goes
 * red; add a `navigator.credentials` call to any site component and the second does.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;
const hero = readFileSync(join(SRC, "lib/components/site/sections/HeroSection.svelte"), "utf8");

test("the hero button only ever links through safeHref", () => {
  assert.match(hero, /const ctaHref = \$derived\(safeHref\(section\.ctaHref\)\)/);
  assert.match(hero, /href=\{ctaHref\}/);
  assert.ok(!/href=\{section\./.test(hero), "no raw organiser value in an href");
  assert.match(hero, /safeSwarmRef\(section\.bgImageRef\)/);
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

test("site components call no WebAuthn API themselves", () => {
  const files = [...walk(join(SRC, "lib/components/site")), join(SRC, "MultiSiteApp.svelte")];
  assert.ok(files.length > 10, "the scan reaches the site components");
  for (const f of files) assert.ok(!readFileSync(f, "utf8").includes("navigator.credentials"), f);
});
