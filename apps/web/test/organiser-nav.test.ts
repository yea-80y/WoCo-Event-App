/**
 * The two bottom bars are one design: five slots in the same places in WoCo and
 * in organiser mode, drawn by one shared component, and the organiser slot count
 * never changes after paint (a Profile tab that appeared once sign-in finished
 * used to shove the others sideways). And the organiser workspace is never
 * called "Studio": WoCo sells tickets for matches and theme parks as much as for
 * gigs (owner decision 2026-10-01).
 *
 * SOURCE SCAN: the shells are Svelte components, which Node cannot mount, and
 * these are source properties.
 *
 * MUTATION: drop or reorder a tab, wrap one in an {#if}, or put "Studio" back in
 * any file under src/, and a case below goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const read = (rel: string) => readFileSync(join(SRC, rel), "utf-8");

/** Tab ids in the order a shell's `tabs` array lists them. */
function tabIds(src: string): string[] {
  const start = src.indexOf("const tabs = $derived<TabItem[]>([");
  assert.notEqual(start, -1, "the shell no longer builds a `tabs` list for TabBar");
  const end = src.indexOf("]);", start);
  return [...src.slice(start, end).matchAll(/\bid: "([a-z]+)"/g)].map((m) => m[1]);
}

const WOCO = read("lib/layouts/AttendeeShell.svelte");
const ORGANISER = read("lib/layouts/CreatorShell.svelte");

test("both bars have five tabs, with the key in the middle and you at the end", () => {
  assert.deepEqual(tabIds(WOCO), ["home", "events", "invite", "contacts", "profile"]);
  assert.deepEqual(tabIds(ORGANISER), ["dashboard", "events", "build", "audience", "profile"]);
});

test("both shells draw their bar with the shared component", () => {
  for (const [name, src] of [["AttendeeShell", WOCO], ["CreatorShell", ORGANISER]] as const) {
    assert.match(src, /<TabBar label="[^"]+" items=\{tabs\} \/>/, `${name} must render the shared TabBar`);
    assert.doesNotMatch(src, /class="bottom-nav/, `${name} still carries its own bar markup`);
  }
});

test("the organiser bar is never inside an {#if}, so no tab can pop in after paint", () => {
  const at = ORGANISER.indexOf("<TabBar ");
  const before = ORGANISER.slice(ORGANISER.indexOf("<main>"), at);
  const opened = (before.match(/\{#if\b/g) ?? []).length;
  const closed = (before.match(/\{\/if\}/g) ?? []).length;
  assert.equal(opened, closed, "the organiser TabBar sits inside an open {#if} block");
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(svelte|ts)$/.test(entry) ? [path] : [];
  });
}

test('no file under src/ says "Studio"', () => {
  const hits = sourceFiles(SRC).flatMap((path) =>
    readFileSync(path, "utf-8")
      .split("\n")
      .flatMap((line, i) => (/\bstudio\b/i.test(line) ? [`${path.slice(SRC.length + 1)}:${i + 1}`] : [])),
  );
  assert.deepEqual(hits, [], `"Studio" is back: ${hits.join(", ")}`);
});
