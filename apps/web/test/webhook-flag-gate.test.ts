/**
 * The dashboard's per-order webhook is OFF (FEATURES.webhooksAllowed, 2026-10-31),
 * and the dashboard must not offer what the server refuses. While off it also
 * deletes the stored config, which held the endpoint's auth header in clear.
 *
 * SOURCE SCAN, as in badges-flag-gate.test.ts: Svelte components cannot be mounted
 * in Node, and the property is a source property - every webhook entry point sits
 * inside the TRUE branch of an `{#if FEATURES.webhooksAllowed ...}` block.
 *
 * MUTATION: move the panel, the bulk send, the column header or the cell out of
 * its block, or drop the config clean-up, and a case below goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FEATURES } from "@woco/shared";

const DASH = readFileSync(new URL("../src/lib/creator/dashboard/Dashboard.svelte", import.meta.url), "utf-8");

/** Spans of the TRUE branch of every `{#if FEATURES.webhooksAllowed ...}` block. */
function guardedSpans(src: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const opener = /\{#if FEATURES\.webhooksAllowed\b[^}]*\}/g;
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

const spans = guardedSpans(DASH);
const guarded = (needle: string) => {
  let from = 0;
  let found = false;
  for (;;) {
    const at = DASH.indexOf(needle, from);
    if (at < 0) break;
    found = true;
    if (!spans.some(([a, b]) => at > a && at < b)) return false;
    from = at + needle.length;
  }
  assert.ok(found, `${needle} is not in the dashboard - update this test`);
  return true;
};

test("the flag is off", () => {
  assert.equal(FEATURES.webhooksAllowed, false);
});

test("every webhook entry point is inside the flag", () => {
  for (const needle of ['class="webhook-section"', "sendAllUnsent(series.seriesId", "<th>Webhook</th>", 'class="webhook-cell"']) {
    assert.ok(guarded(needle), `${needle} must sit inside {#if FEATURES.webhooksAllowed}`);
  }
});

test("while off, the stored config (with its auth header) is deleted and never loaded", () => {
  assert.match(DASH, /if \(!FEATURES\.webhooksAllowed\) clearWebhookConfig\(\);/);
  assert.match(DASH, /webhookConfig = FEATURES\.webhooksAllowed \? loadWebhookConfig\(\) : null;/);
  assert.match(DASH, /function clearWebhookConfig\(\) \{\s*localStorage\.removeItem\(`woco:webhook:\$\{eventId\}`\);/);
});
