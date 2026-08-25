/**
 * #194 — `loginRequest.request()` must never hand back a promise nobody can settle.
 *
 * The promise is resolved only by a mounted login modal. With none mounted the
 * caller awaits forever behind a spinner: no error, no timeout, no cancel. Three
 * such callers once shipped inside the deployed-builder-site bundle, which mounts
 * no modal, and nothing in review showed it — the defect lives in the import graph,
 * not in any one file.
 *
 * These are TEXT checks, not runtime ones, and that limitation is the point of
 * saying so here: `login-request.svelte.ts` is a runes module, and this suite runs
 * under plain tsx, which cannot execute `$state`. The repo has no component-test
 * harness either. Same shape as apps/server/test/data-store-modes.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".svelte") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const FILES = walk(SRC).map((p) => ({ path: p, text: readFileSync(p, "utf8") }));

test("request() refuses instead of hanging when no modal is mounted", () => {
  const store = FILES.find((f) => f.path.endsWith("auth/login-request.svelte.ts"));
  assert.ok(store, "login-request.svelte.ts not found");
  assert.match(
    store!.text,
    /_modals === 0[\s\S]{0,220}return Promise\.resolve\(false\)/,
    "request() must return a settled false when no modal is registered",
  );
});

test("every component that can settle a login request also registers itself", () => {
  // Being able to call resolve() is what makes a component a login surface. If it
  // can settle requests it must also declare that it exists, or `available` — and
  // the guard that reads it — understates what the bundle can do.
  const settlers = FILES.filter(
    (f) => f.path.endsWith(".svelte") && /loginRequest\.resolve\(/.test(f.text),
  );
  assert.ok(settlers.length >= 2, "expected at least the app and site login modals");
  for (const f of settlers) {
    assert.match(
      f.text,
      /loginRequest\.register\(\)/,
      `${f.path.slice(SRC.length)} settles login requests but never registers`,
    );
  }
});
