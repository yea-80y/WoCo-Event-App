/**
 * #1032 slice 4a: a site that linked an older runtime release is offered an
 * update, and every site deploy in the app builds in the browser.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { runtimeUpdateAvailable } from "../src/lib/creator/builder/runtime-update.js";

test("only a linked site behind the latest release is offered an update", () => {
  assert.equal(runtimeUpdateAvailable({ runtimeVersion: 1 }, 2), true);
  assert.equal(runtimeUpdateAvailable({ runtimeVersion: 2 }, 2), false);
  assert.equal(runtimeUpdateAvailable({ runtimeVersion: 3 }, 2), false, "ahead of a lagging read");
  assert.equal(runtimeUpdateAvailable({}, 2), false, "a full copy carries no version");
  assert.equal(runtimeUpdateAvailable({ runtimeVersion: 1 }, null), false, "no release read");
});

const SRC = new URL("../src/", import.meta.url).pathname;
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|svelte)$/.test(n) ? [p] : [];
  });
}

test("every deploySite call passes the account address, so it builds in the browser", () => {
  const calls: string[] = [];
  for (const file of sources(SRC)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/await deploySite\(([\s\S]*?)\);/g)) {
      calls.push(file.slice(SRC.length));
      assert.match(m[1]!, /parentAddress:/, `${file.slice(SRC.length)} deploys without parentAddress`);
    }
  }
  assert.ok(calls.length >= 3, `found ${calls.join(", ")}`);
});
