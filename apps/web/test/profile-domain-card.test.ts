/**
 * The Profile domain card must not claim a name the chain does not give this
 * account.
 *
 * 2026-11-02: an account's profile feed still named `1ntl`, minted on the
 * registry retired at the 10-23 reset. The header hid it (it is verified), but
 * the card handed the raw feed label to SubENSPicker, whose claimed view says
 * "{name} is yours". The feed is client-signed and survives any contract reset,
 * so the label is a claim, never a fact.
 *
 * SOURCE SCAN, deliberately: the property is which value the page passes to
 * the picker, and observing it at runtime would mean rendering Svelte.
 *
 * MUTATION: put `claimedLabel={profile?.subEnsLabel}` back on the picker, or
 * `const previous = profile?.subEnsLabel;` back in handleSubEnsClaim, and this
 * goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PAGE = fileURLToPath(
  new URL("../src/lib/components/profile/ProfilePage.svelte", import.meta.url),
);
const text = readFileSync(PAGE, "utf-8");

test("the scan actually reaches ProfilePage", () => {
  assert.ok(text.length > 10_000, `ProfilePage.svelte read as ${text.length} bytes — wrong file?`);
  assert.match(text, /<script lang="ts">/, "…and it must be the Svelte component");
});

test("every SubENSPicker on the page gets the label only once it is verified", () => {
  const pickers = [...text.matchAll(/<SubENSPicker\b[\s\S]*?\/>/g)].map((m) => m[0]);
  assert.ok(pickers.length > 0, "no SubENSPicker found — the scan would pass vacuously");
  for (const tag of pickers) {
    const attr = tag.match(/claimedLabel=\{([^}]*)\}/);
    assert.ok(attr, `picker without a claimedLabel attribute:\n${tag}`);
    assert.match(
      attr[1]!.trim(),
      /^nameVerified\s*\?\s*profile\?\.subEnsLabel\s*:\s*undefined$/,
      "the picker's claimed view says 'is yours': it must only see a chain-verified label",
    );
  }
});

test("the discard offer is only made for a name the chain said was ours", () => {
  const assign = text.match(/const previous = ([^;]*);/);
  assert.ok(assign, "handleSubEnsClaim no longer captures `previous` — re-check the discard offer");
  assert.match(
    assign[1]!,
    /^nameVerified\s*\?/,
    "'You still own {name}' must not be said of a stale feed label",
  );
});
