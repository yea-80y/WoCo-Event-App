/**
 * Badges, drops and badge-gated ticket sales are OFF for launch
 * (FEATURES.badgesAllowed), and the client must not offer a door the server
 * refuses. The Objects TAB stays - it lists every published event's tickets - so
 * only the creation and gating entry points are guarded.
 *
 * SOURCE SCAN, as in shop-flag-gate.test.ts: these are Svelte components, which
 * Node cannot mount, and the property is a source property - each entry point
 * sits inside the TRUE branch of `{#if FEATURES.badgesAllowed}`.
 *
 * MUTATION: move any guarded entry point out of its block, or flip the flag, and
 * a case below goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FEATURES } from "@woco/shared";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const read = (rel: string) => readFileSync(`${SRC}/${rel}`, "utf-8");

/** Spans of the TRUE branch of every `{#if FEATURES.badgesAllowed}` block. */
function guardedSpans(src: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const opener = /\{#if FEATURES\.badgesAllowed\}/g;
  const tag = /\{#if\b|\{:else\b|\{\/if\}/g;
  let m: RegExpExecArray | null;
  while ((m = opener.exec(src)) !== null) {
    tag.lastIndex = m.index + m[0].length;
    let depth = 0;
    let end = -1;
    let t: RegExpExecArray | null;
    while ((t = tag.exec(src)) !== null) {
      if (t[0] === "{#if") depth += 1;
      else if (depth > 0) { if (t[0] === "{/if}") depth -= 1; }
      else { end = t.index; break; }
    }
    assert.notEqual(end, -1, "unterminated {#if} - the scan lost the block");
    spans.push([m.index, end]);
  }
  return spans;
}

/** Every occurrence of `needle` must sit inside a guarded span; at least one must exist. */
function assertAllGuarded(src: string, needle: string, file: string) {
  const spans = guardedSpans(src);
  let i = src.indexOf(needle);
  assert.notEqual(i, -1, `${file} no longer contains ${needle} - update this test`);
  for (; i !== -1; i = src.indexOf(needle, i + 1)) {
    assert.ok(spans.some(([a, b]) => i > a && i < b), `${file}: ${needle} at ${i} is reachable with the flag off`);
  }
}

test("the flag is off for launch", () => {
  assert.equal(FEATURES.badgesAllowed, false);
});

test("the Create menu offers no 'New object' while badges are off", () => {
  assertAllGuarded(read("lib/layouts/CreatorShell.svelte"), 'create("/creator/objects")', "CreatorShell.svelte");
});

test("the Objects TAB itself stays in the creator nav", () => {
  const src = read("lib/layouts/CreatorShell.svelte");
  const i = src.indexOf('navigate("/creator/objects")');
  assert.notEqual(i, -1, "the Objects tab button is gone");
  assert.ok(!guardedSpans(src).some(([a, b]) => i > a && i < b), "the Objects tab must not be hidden with badges");
});

test("the Objects screen has no create button or create modal while badges are off", () => {
  const src = read("lib/components/object/ObjectManager.svelte");
  assertAllGuarded(src, "onclick={onCreate}", "ObjectManager.svelte");
  assertAllGuarded(src, "<ObjectCreateModal", "ObjectManager.svelte");
});

test("the ticket editor offers no badge gate while badges are off", () => {
  assertAllGuarded(read("lib/creator/events/TicketSeriesEditor.svelte"), "<ObjectGateEditor", "TicketSeriesEditor.svelte");
});
