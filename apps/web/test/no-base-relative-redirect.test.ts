/**
 * A scripted redirect must never be relative (#605).
 *
 * The app deploy injects `<base href="https://gateway.woco-net.com/bzz/{hash}/">`
 * so its assets load from the gateway. `location.replace/assign` and a
 * `location.href =` write resolve a RELATIVE URL against that base, not the
 * page: on 2026-09-22 opening `nabil.woco.eth.limo` sent the user to
 * `https://gateway.woco-net.com/#/profile/0x…` - the gateway's bare root, which
 * answers "Cannot GET /". Build the target from the page's own URL instead:
 * `new URL("#/…", window.location.href).href`.
 *
 * `history.pushState/replaceState` resolve against the same base, and a
 * cross-origin result THROWS - verified in the live app 2026-09-22 - so every
 * URL-clean-up and the checkout Back guard silently did nothing there.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(ts|svelte)$/.test(name) ? [p] : [];
  });
}

/** A literal target that is relative: `#…`, `/…`, `./…`, `../…`, or built on `location.pathname`. */
const RELATIVE_TARGET = String.raw`\s*(?:["'\x60](?:#|\/|\.\.?\/)|\x60\$\{\s*(?:window\.)?location\.pathname\s*\})`;
const RELATIVE_REDIRECT = new RegExp(
  String.raw`location\.(?:replace|assign)\(` + RELATIVE_TARGET + "|" + String.raw`location\.href\s*=` + RELATIVE_TARGET,
);

test("no scripted redirect in the web app is relative", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    readFileSync(file, "utf-8")
      .split("\n")
      .forEach((line, i) => {
        if (line.trimStart().startsWith("//")) return;
        if (RELATIVE_REDIRECT.test(line)) offenders.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(offenders, [], "build the URL from window.location.href, never relative");
});

test("the guard recognises every relative shape it exists for", () => {
  for (const bad of [
    "window.location.replace(`${window.location.pathname}#/profile/${a}`);",
    "window.location.replace(`#/event/${id}/purchased`);",
    'window.location.replace("#/");',
    "location.assign('/x');",
    'window.location.href = "./y";',
    "location.href = `../z`;",
  ]) {
    assert.match(bad, RELATIVE_REDIRECT, bad);
  }
  for (const ok of [
    "window.location.replace(new URL(`#/profile/${a}`, window.location.href).href);",
    "window.location.replace(url);",
    'window.location.href = "https://woco.eth.limo/#/";',
  ]) {
    assert.doesNotMatch(ok, RELATIVE_REDIRECT, ok);
  }
});

const HISTORY_CALL = /history\.(?:pushState|replaceState)\(/;

test("every history push/replace builds its URL absolute, from the page's own URL", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    readFileSync(file, "utf-8")
      .split("\n")
      .forEach((line, i) => {
        if (line.trimStart().startsWith("//") || !HISTORY_CALL.test(line)) return;
        if (!/new URL\([^;]*location\.href\)\.href/.test(line)) offenders.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(offenders, [], "wrap the URL in new URL(…, window.location.href).href");
});
