/**
 * A stored sub-ENS label is shown as "yours" only once the chain agrees.
 *
 * 2026-11-02: an account's profile feed still named `1ntl`, minted on the
 * registry retired at the 10-23 reset. The header hid it (it is verified), but
 * the Profile domain card handed the raw feed label to SubENSPicker, whose
 * claimed view says "{name} is yours". The site builder's Domain tab did the
 * same with a site config's label, and Publish asked for the holder key to
 * point it. Both feeds are client-signed and survive any contract change, so
 * the label is a claim, never a fact.
 *
 * SOURCE SCAN, deliberately: the property is which value each page passes to
 * the picker, and observing it at runtime would mean rendering Svelte.
 *
 * MUTATION: put `claimedLabel={profile?.subEnsLabel}` back on the profile
 * picker, `bind:claimedLabel={site.subEnsLabel}` back on the builder's, drop
 * `siteNameVerified &&` from siteNameToPoint, or put
 * `const previous = profile?.subEnsLabel;` back - and this goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function read(rel: string): string {
  const text = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");
  // A rename or move would empty the scan and every assertion would pass vacuously.
  assert.ok(text.length > 10_000, `${rel} read as ${text.length} bytes — wrong file?`);
  assert.match(text, /<script lang="ts">/, `${rel} must be the Svelte component`);
  return text;
}

const profile = read("../src/lib/components/profile/ProfilePage.svelte");
const builder = read("../src/lib/creator/builder/MultiSiteBuilder.svelte");

function pickers(text: string): string[] {
  const tags = [...text.matchAll(/<SubENSPicker\b[\s\S]*?\/>/g)].map((m) => m[0]);
  assert.ok(tags.length > 0, "no SubENSPicker found — the scan would pass vacuously");
  return tags;
}

function claimedLabelOf(tag: string): string {
  assert.doesNotMatch(tag, /bind:claimedLabel/, `a bound picker can be handed the raw label:\n${tag}`);
  const attr = tag.match(/claimedLabel=\{([^}]*)\}/);
  assert.ok(attr, `picker without a claimedLabel attribute:\n${tag}`);
  return attr[1]!.trim();
}

// ---------------------------------------------------------------------------
// Profile page
// ---------------------------------------------------------------------------

test("profile: nameVerified means the chain check said 'owned', and nothing else", () => {
  // The picker gate below trusts this name; re-pointing it would re-open the bug.
  assert.match(profile, /const nameVerified = \$derived\(nameCheck === "owned"\);/);
});

test("profile: every SubENSPicker gets the label only once it is verified", () => {
  for (const tag of pickers(profile)) {
    assert.match(
      claimedLabelOf(tag),
      /^nameVerified\s*\?\s*profile\?\.subEnsLabel\s*:\s*undefined$/,
      "the picker's claimed view says 'is yours': it must only see a chain-verified label",
    );
  }
});

test("profile: the discard offer is only made for a name the chain said was ours", () => {
  const assign = profile.match(/const previous = ([^;]*);/);
  assert.ok(assign, "handleSubEnsClaim no longer captures `previous` — re-check the discard offer");
  assert.match(assign[1]!, /^nameVerified\s*\?/, "'You still own {name}' must not be said of a stale feed label");
});

// ---------------------------------------------------------------------------
// Site builder
// ---------------------------------------------------------------------------

test("builder: siteNameVerified means the chain check said 'owned', and nothing else", () => {
  assert.match(builder, /const siteNameVerified = \$derived\(siteNameCheck === 'owned'\);/);
});

test("builder: every SubENSPicker gets the site's label only once it is verified", () => {
  for (const tag of pickers(builder)) {
    assert.match(
      claimedLabelOf(tag),
      /^siteNameVerified\s*\?\s*site\.subEnsLabel\s*:\s*undefined$/,
      "the Domain tab says 'is yours' / 'Linked to your site': it must only see a chain-verified label",
    );
  }
});

test("builder: a claim is remembered as this account's before the label is stored", () => {
  // Load-bearing: re-claiming a stale label hits a fresh "no such name" verdict
  // (2 min), which checkName returns without a read - so without this the tab
  // says "isn't registered" right after a successful mint.
  const onclaim = builder.match(/onclaim=\{\(label\) => \{([\s\S]*?)\}\}/);
  assert.ok(onclaim, "builder onclaim moved");
  const body = onclaim[1]!;
  const remembered = body.indexOf("rememberOwner(label, auth.parent)");
  const stored = body.indexOf("site.subEnsLabel = label");
  assert.ok(remembered >= 0 && stored > remembered, "rememberOwner must precede storing the label");
});

test("builder: Publish only asks to point a name the chain says this account holds", () => {
  const derived = builder.match(/const siteNameToPoint = \$derived\(([\s\S]*?)\);\n/);
  assert.ok(derived, "siteNameToPoint moved — re-check what Publish asks the holder to sign");
  assert.match(derived[1]!, /siteNameVerified\s*&&/, "a stale label must not raise the holder-key prompt");
});
