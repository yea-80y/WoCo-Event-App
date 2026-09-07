/**
 * Every sub-ENS mint goes through the WoCo SPONSOR wallet, for every login kind
 * (#489). No screen may route a passkey user back to the permit rail.
 *
 * A ratchet on the two mint call sites rather than a unit test, for the reason
 * `cert-mint-binding.test.ts` gives: the choice is made inside a Svelte
 * component, by an `auth.kind` branch, and there is no seam to inject. The
 * failure it guards is silent — a permit mint still SUCCEEDS on the chain the
 * scoped session key was minted for, so a leftover branch would look like a
 * working feature right up until the Kernel chain and the registrar chain
 * disagree, and then it would fail at a user's deploy with a bundler error.
 *
 * Comments are stripped before matching: they name the retired rail on purpose,
 * to say why it is gone. A ratchet that read prose would fire on the
 * explanation and be silenced by deleting it, which is backwards.
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

  test(`${name} never routes a mint through the permit rail`, () => {
    assert.doesNotMatch(
      code(rel),
      /claimSubEnsViaPermit/,
      "a passkey mint is back on the gasless permit rail — every kind mints via the sponsor (#489)",
    );
  });

  test(`${name} does not mint a scoped session key to claim a name`, () => {
    // `ensureWocoSessionKey` is what makes the permit rail possible: it is the
    // key the userOp is signed with. Its presence at a MINT site means the
    // permit branch came back even if the call was renamed.
    assert.doesNotMatch(code(rel), /ensureWocoSessionKey/);
  });
}
