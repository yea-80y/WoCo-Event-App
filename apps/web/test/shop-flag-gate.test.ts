/**
 * The shop rail is flagged off for launch (#124), and the client must not offer
 * a door the server will slam.
 *
 * SOURCE SCAN, deliberately. `router.svelte.ts` declares `$state`, so Node
 * cannot import it — `$state is not defined` is thrown at module evaluation,
 * and no amount of shimming makes a runtime assertion about the real routing
 * function honest. The property being pinned is a source property anyway: the
 * five shop matches are unreachable while the flag is off because they sit
 * inside `if (FEATURES.shopAllowed)`, so unknown-path fall-through takes them
 * to the splitter.
 *
 * MUTATION: unwrap any one of the shop returns from its guard, drop the
 * `FEATURES` import, flip the flag, or turn a CreatorApp shop loader back into
 * a static import, and one of these goes red.
 *
 * KNOWN LIMIT: the brace walk below is naive about braces inside strings,
 * regexes and comments. Today the guarded blocks contain neither, and a future
 * edit that breaks the walk fails LOUD rather than passing vacuously.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const read = (rel: string) => readFileSync(`${SRC}/${rel}`, "utf-8");

const ROUTER = read("lib/router/router.svelte.ts");

/** Every route name the shop rail owns. Guarding four of five is not guarding. */
const SHOP_ROUTES = ["my-shops", "shop-pos", "shop-editor", "shop-tap", "shop-order"];

/** Character spans covered by an `if (FEATURES.shopAllowed) { … }` block. */
function guardedSpans(src: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const opener = /if\s*\(\s*FEATURES\.shopAllowed\s*\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = opener.exec(src)) !== null) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let i = open;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    assert.notEqual(i, src.length, "unbalanced braces — the brace walk lost the block");
    spans.push([m.index, i]);
  }
  return spans;
}

test("the scan actually reaches the router it is about", () => {
  // Without this, a rename or a refactor that empties the file would leave every
  // assertion below passing on nothing — the classic silently-toothless ratchet.
  assert.match(ROUTER, /function matchRoute\(/, "router.svelte.ts must still own matchRoute");
  assert.match(
    ROUTER,
    /return \{ route: "splitter", params: \{\}, surface: "neutral" \};\s*\}/,
    "the unknown-path fall-through is what a refused shop route lands on",
  );
  for (const name of SHOP_ROUTES) {
    assert.ok(ROUTER.includes(`route: "${name}"`), `${name} must still be a route in this file`);
  }
});

test("the router imports the flag it claims to read", () => {
  assert.match(
    ROUTER,
    /^\s*import\s*\{[^}]*\bFEATURES\b[^}]*\}\s*from\s*["']@woco\/shared["']/m,
    "an undeclared FEATURES would be a build error, but only once someone builds",
  );
});

test("every shop route sits inside an if (FEATURES.shopAllowed) block", () => {
  const spans = guardedSpans(ROUTER);
  assert.ok(spans.length > 0, "no shop guard found at all");

  const inside = (idx: number) => spans.some(([from, to]) => idx > from && idx < to);

  for (const name of SHOP_ROUTES) {
    const needle = `route: "${name}"`;
    let from = 0;
    let seen = 0;
    for (;;) {
      const idx = ROUTER.indexOf(needle, from);
      if (idx === -1) break;
      seen += 1;
      assert.ok(inside(idx), `${needle} is reachable with the shop rail off`);
      from = idx + needle.length;
    }
    assert.ok(seen > 0, `${needle} vanished — update this test or the rail`);
  }
});

test("the shop screens are gated wherever they render outside the router", () => {
  // The router refuses the paths, but these two render off their own state:
  // ProfilePage from a tab, MultiSiteApp from a deployed site's own hash parse.
  const profile = read("lib/components/profile/ProfilePage.svelte");
  assert.match(
    profile,
    /\{#if\s+FEATURES\.shopAllowed\s*&&\s*auth\.kind === "passkey"\}\s*<SpendingWallet\s*\/>/,
    "a spending wallet only ever funds a shop draw",
  );

  const multisite = read("MultiSiteApp.svelte");
  assert.match(
    multisite,
    /\{#if\s+FEATURES\.shopAllowed\}\s*<ShopOrderScreen/,
    "a published site renders its own shop-order hash without asking the router",
  );
});

test("CreatorApp loads the shop screens lazily, so a closed rail costs no boot bytes", () => {
  const creator = read("CreatorApp.svelte");
  for (const screen of ["MyShopsScreen", "ShopEditor", "ShopPosShell"]) {
    assert.match(
      creator,
      new RegExp(`\\(\\) => import\\(["'][^"']*${screen}\\.svelte["']\\)`),
      `${screen} must be behind a dynamic import`,
    );
    assert.doesNotMatch(
      creator,
      new RegExp(`^\\s*import\\s+${screen}\\s+from`, "m"),
      `a static import puts ${screen} back in the creator boot chunk`,
    );
  }
});

test("the shipped flag is off", async () => {
  const { FEATURES } = await import("@woco/shared");
  assert.equal(FEATURES.shopAllowed, false);
});
