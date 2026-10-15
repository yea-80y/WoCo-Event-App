/**
 * No page from `public/` can reach the door scanner's build.
 *
 * `public/` holds test pages that call `navigator.credentials` with the RP ID
 * `woco.eth.limo`, and the scanner is served at `scan.woco.eth.limo`, under that
 * RP ID. So the scanner build takes no `publicDir` and copies an allowlist
 * (vite-plugins/scanner-public.ts) - and its service worker precaches only what
 * the build emitted.
 *
 * MUTATIONS (each turns this file red): drop `publicDir: false`; add a page or
 * script to SCANNER_PUBLIC_FILES; drop the plugin from the scanner config; have
 * the plugin emit anything beyond its list.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, UserConfig } from "vite";
import { SCANNER_PUBLIC_FILES, scannerPublicFiles } from "../vite-plugins/scanner-public.js";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [relative(PUBLIC, p)];
  });
}

const PAGE_OR_SCRIPT = /\.(html?|m?js|cjs|svg|xml)$/i;

test("the scanner's allowlist is assets only, and each one exists", () => {
  for (const name of SCANNER_PUBLIC_FILES) {
    assert.ok(!PAGE_OR_SCRIPT.test(name), `${name} could run in the scanner's origin`);
    assert.ok(files(PUBLIC).includes(name), `${name} is not in public/`);
  }
});

test("no page or script in public/ is on the scanner's allowlist", () => {
  const pages = files(PUBLIC).filter((f) => PAGE_OR_SCRIPT.test(f));
  for (const page of pages) {
    assert.ok(!(SCANNER_PUBLIC_FILES as readonly string[]).includes(page), page);
  }
});

test("the plugin emits exactly its list into the build", () => {
  const emitted: string[] = [];
  const plugin = scannerPublicFiles(PUBLIC);
  const generate = plugin.generateBundle as unknown as (this: { emitFile: (f: { fileName: string }) => void }) => void;
  generate.call({ emitFile: (f) => emitted.push(f.fileName) });
  assert.deepEqual(emitted, [...SCANNER_PUBLIC_FILES]);
});

test("the scanner config copies no publicDir, and uses the allowlist instead", async () => {
  const config = (await import("../vite.scanner.config.ts")).default as UserConfig;
  assert.equal(config.publicDir, false);
  const names = (config.plugins ?? []).flat(Infinity as 1).map((p) => (p as Plugin | null)?.name);
  assert.ok(names.includes("scanner-public-files"), "the allowlist plugin is in the build");
});
