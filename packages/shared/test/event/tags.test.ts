/**
 * Discovery-tag normaliser (#37). Covers the build-time filter policy: controlled-
 * vocab canonicalisation, coercion of unknown values AND unknown facets to `other`,
 * dedupe, caps, empty/undefined input, and determinism.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseTags } from "../../src/event/tags.js";
import type { EventTag } from "../../src/event/types.js";

test("canonicalises a known controlled value's casing", () => {
  assert.deepEqual(normaliseTags([{ type: "location", value: "LONDON" }]), [{ type: "location", value: "London" }]);
  assert.deepEqual(normaliseTags([{ type: "genre", value: "  music " }]), [{ type: "genre", value: "Music" }]);
});

test("unknown controlled value → other (kept, not dropped)", () => {
  assert.deepEqual(normaliseTags([{ type: "location", value: "Narnia" }]), [{ type: "other", value: "Narnia" }]);
  assert.deepEqual(normaliseTags([{ type: "genre", value: "Vaporwave" }]), [{ type: "other", value: "Vaporwave" }]);
});

test("unknown facet type → other (incl. non-string type)", () => {
  assert.deepEqual(normaliseTags([{ type: "mood" as unknown as EventTag["type"], value: "chill" }]), [{ type: "other", value: "chill" }]);
  assert.deepEqual(normaliseTags([{ type: 42 as unknown as EventTag["type"], value: "x" }]), [{ type: "other", value: "x" }]);
});

test("free-text facets pass through unchanged", () => {
  assert.deepEqual(normaliseTags([{ type: "artist", value: "Aphex Twin" }]), [{ type: "artist", value: "Aphex Twin" }]);
  assert.deepEqual(normaliseTags([{ type: "other", value: "Warehouse" }]), [{ type: "other", value: "Warehouse" }]);
});

test("dedupes by (type, value) case-insensitively", () => {
  const out = normaliseTags([
    { type: "genre", value: "Music" },
    { type: "genre", value: "music" },
    { type: "genre", value: "MUSIC" },
  ]);
  assert.deepEqual(out, [{ type: "genre", value: "Music" }]);
});

test("drops empty / whitespace-only values", () => {
  assert.deepEqual(normaliseTags([{ type: "other", value: "" }, { type: "genre", value: "   " }]), []);
});

test("caps tag count at 12", () => {
  const many: EventTag[] = Array.from({ length: 20 }, (_, i) => ({ type: "other", value: `t${i}` }));
  assert.equal(normaliseTags(many).length, 12);
});

test("caps value length at 48 chars", () => {
  const long = "x".repeat(100);
  const out = normaliseTags([{ type: "other", value: long }]);
  assert.equal(out[0].value.length, 48);
});

test("empty and undefined input → []", () => {
  assert.deepEqual(normaliseTags([]), []);
  assert.deepEqual(normaliseTags(undefined), []);
});

test("deterministic — same input twice yields deep-equal output", () => {
  const input: EventTag[] = [
    { type: "location", value: "manchester" },
    { type: "genre", value: "Nightlife" },
    { type: "mood" as unknown as EventTag["type"], value: "loud" },
    { type: "genre", value: "NIGHTLIFE" },
  ];
  assert.deepEqual(normaliseTags(input), normaliseTags(input));
});
