/**
 * A `.woco.eth` name's web suffix is ONE constant, and this is what keeps it one.
 *
 * The suffix is a property of the gateway we point people at, not of the name,
 * and it has already been flipped twice. A spelled-out `<label>.woco.eth.limo`
 * or `<label>.woco.eth.link` is therefore not a cosmetic duplicate of
 * SUB_ENS_WEB_SUFFIX — it is one link silently pinned to one gateway, which
 * keeps working right up until the constant moves and then sends organisers
 * somewhere the rest of the app no longer uses. A text walk catches it because
 * the stale link lives in whichever file spelled the suffix out, not in the one
 * place a reviewer would look.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { subEnsName, subEnsWebUrl } from "@woco/shared";

test("the helpers build the name and the browsable address", () => {
  assert.equal(subEnsName("nabil"), "nabil.woco.eth");
  assert.equal(subEnsWebUrl("nabil"), "https://nabil.woco.eth.limo");
});

const SRC = new URL("../src/", import.meta.url).pathname;

/**
 * The door scanner's own host — a WoCo-operated app, not a holder's name, and
 * dead code besides (VITE_SCANNER_URL is set in .env and .env.production, so the
 * fallback is never reached). Left alone deliberately: repointing it is a
 * behaviour change to the scanner, and whether `scan.woco.eth` is registered at
 * all is unverified.
 */
const ALLOWED = new Set(["lib/creator/dashboard/CheckinPanel.svelte"]);

/** Both spellings of the same eth.limo stack — either one pins a link. */
const SPELLED_OUT = [".woco.eth.limo", ".woco.eth.link"];

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
    const text = readFileSync(path, "utf8");
    for (const suffix of SPELLED_OUT) {
      assert.ok(
        !text.includes(suffix),
        `${rel} spells out a ${suffix} address — that link stays pinned to one ` +
          `gateway when SUB_ENS_WEB_SUFFIX moves. Build it with subEnsWebUrl() ` +
          `from @woco/shared, where the suffix flips in one line.`,
      );
    }
  }
});
