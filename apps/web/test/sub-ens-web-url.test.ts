/**
 * A `.woco.eth` name's web suffix is ONE constant, and this is what keeps it one.
 *
 * eth.limo refuses to issue a TLS certificate for our two-label subnames, so a
 * stray `<label>.woco.eth.limo` literal is not a cosmetic duplicate of the
 * constant — it is a link that dies in the browser before any resolver is asked,
 * which reads to the organiser as "my name doesn't work". A text walk catches it
 * because the failure lives in whichever file spelled the suffix out, not in the
 * one place a reviewer would look.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { subEnsName, subEnsWebUrl } from "@woco/shared";

test("the helpers build the name and the browsable address", () => {
  assert.equal(subEnsName("nabil"), "nabil.woco.eth");
  assert.equal(subEnsWebUrl("nabil"), "https://nabil.woco.eth.link");
});

const SRC = new URL("../src/", import.meta.url).pathname;

/**
 * The door scanner's own host — a WoCo-operated app, not a holder's name, and
 * dead code besides (VITE_SCANNER_URL is set in .env and .env.production, so the
 * fallback is never reached). Left alone deliberately: repointing it is a
 * behaviour change to the scanner, and whether `scan.woco.eth` is registered at
 * all is unverified. It carries the same broken-certificate defect.
 */
const ALLOWED = new Set(["lib/creator/dashboard/CheckinPanel.svelte"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".svelte") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("no sub-ENS web address is spelled out under apps/web/src", () => {
  for (const path of walk(SRC)) {
    const rel = relative(SRC, path);
    if (ALLOWED.has(rel)) continue;
    assert.ok(
      !readFileSync(path, "utf8").includes(".woco.eth.limo"),
      `${rel} spells out a .woco.eth.limo address — eth.limo has no certificate ` +
        `for our subnames, so that link cannot load. Build it with subEnsWebUrl() ` +
        `from @woco/shared, where the suffix flips in one line.`,
    );
  }
});
