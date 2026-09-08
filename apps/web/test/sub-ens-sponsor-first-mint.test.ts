/**
 * Every sub-ENS mint goes through the WoCo SPONSOR wallet, for every login kind
 * (#489) — the owner's permanent decision, not a stopgap.
 *
 * A ratchet on the two mint call sites rather than a unit test, for the reason
 * `cert-mint-binding.test.ts` gives: the choice is made inside a Svelte
 * component, by an `auth.kind` branch, and there is no seam to inject.
 *
 * It used to also assert that neither screen reached for the gasless permit
 * rail. #501 deleted that rail outright, so those two assertions now guard
 * against calling functions that do not exist — which the compiler does, and
 * better. What is left is the positive half: a mint screen must still mint.
 *
 * Comments are stripped before matching, so prose about a retired rail cannot
 * trip a ratchet that reads source.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MINT_SITES = [
  "../src/lib/creator/SiteBuilder.svelte",
  "../src/lib/creator/builder/SubENSPicker.svelte",
];

function code(rel: string): string {
  const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

for (const rel of MINT_SITES) {
  const name = rel.split("/").pop();

  test(`${name} mints through the sponsor path`, () => {
    assert.match(code(rel), /claimSubEnsLabel\(/, "no sponsor mint call left in this screen");
  });

}
