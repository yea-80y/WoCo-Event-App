/**
 * A just-uploaded image can fail its first load (the upload is deferred, Etherna
 * serves it seconds later) and a browser never retries a failed image itself, so
 * the builder's thumbnails stayed broken while the live page was fine.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { retrySameImageUrl } from "../src/lib/components/site/image-fallback.js";

const URL_A = "https://gateway.etherna.io/bytes/" + "ab".repeat(32);
const URL_B = "https://gateway.etherna.io/bytes/" + "cd".repeat(32);

function fakeImg(src: string) {
  const attrs = new Map<string, string>([["src", src]]);
  const sets: string[] = [];
  const img = {
    dataset: {} as Record<string, string>,
    getAttribute: (k: string) => attrs.get(k) ?? null,
    removeAttribute: (k: string) => { attrs.delete(k); },
    setAttribute: (k: string, v: string) => { attrs.set(k, v); if (k === "src") sets.push(v); },
  };
  const fail = () => retrySameImageUrl({ currentTarget: img } as unknown as Event, [10, 20]);
  return { img, attrs, sets, fail };
}

test("a failed load is retried on the same url, once per delay, then given up", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sets, fail } = fakeImg(URL_A);

  fail();
  t.mock.timers.tick(9);
  assert.deepEqual(sets, [], "not before the first delay");
  t.mock.timers.tick(1);
  assert.deepEqual(sets, [URL_A]);

  fail();
  t.mock.timers.tick(20);
  assert.deepEqual(sets, [URL_A, URL_A]);

  fail();
  t.mock.timers.tick(1_000);
  assert.deepEqual(sets, [URL_A, URL_A], "no third retry with two delays");
});

test("an element re-used for another image is never pointed back at the old one", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { attrs, sets, fail } = fakeImg(URL_A);

  fail();
  attrs.set("src", URL_B);
  t.mock.timers.tick(1_000);
  assert.deepEqual(sets, []);
  assert.equal(attrs.get("src"), URL_B);
});

test("a new image in the same element gets its own retries", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { attrs, sets, fail } = fakeImg(URL_A);

  fail(); t.mock.timers.tick(10);
  fail(); t.mock.timers.tick(20);
  attrs.set("src", URL_B);
  fail(); t.mock.timers.tick(10);
  assert.deepEqual(sets, [URL_A, URL_A, URL_B]);
});

test("the builder thumbnails and the gallery retry a failed load", () => {
  const editor = readFileSync(new URL("../src/lib/creator/builder/SectionEditor.svelte", import.meta.url), "utf-8");
  assert.match(editor, /class="gallery-thumb"[^>]*onerror=\{retrySameImageUrl\}/);
  assert.match(editor, /class="image-preview"[^>]*onerror=\{retrySameImageUrl\}/);
  const gallery = readFileSync(new URL("../src/lib/components/site/sections/GallerySection.svelte", import.meta.url), "utf-8");
  assert.match(gallery, /onerror=\{retrySameImageUrl\}/);
});
