/**
 * Every theme renders whole CSS: a colour missing from one palette rendered as
 * the literal `undefined` (the light hold banner lost its border, #1085).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { getStyles } from "../src/components/styles.js";

for (const theme of ["dark", "light"] as const) {
  test(`${theme} theme renders no undefined or null value`, () => {
    const css = getStyles(theme);
    assert.doesNotMatch(css, /\bundefined\b|\bnull\b|NaN/);
  });
}

test("the hold banner has a border colour in both themes", () => {
  for (const theme of ["dark", "light"] as const) {
    const rule = /\.hold-banner\s*\{[^}]*\}/.exec(getStyles(theme))?.[0] ?? "";
    assert.match(rule, /border:\s*1px solid #[0-9a-f]{6};/i, theme);
  }
});
