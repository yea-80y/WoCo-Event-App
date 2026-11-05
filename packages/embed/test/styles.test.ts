/**
 * Every theme renders whole CSS: a colour missing from one palette rendered as
 * the literal `undefined` (the light hold banner lost its border, #1085).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { getStyles } from "../src/components/styles.js";
import { PALETTES } from "../src/components/palette.js";

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

test("the widget downloads nothing for its look: no web font, no stylesheet, no image", () => {
  // Owner 2026-11-05 (#1097): system fonts. A web font is a download on every
  // organiser page, a swap flicker, and a rule injected into the host page
  // (a shadow root cannot load one); the frame's CSP has no font-src either.
  for (const theme of ["dark", "light"] as const) {
    assert.doesNotMatch(getStyles(theme), /@font-face|@import|url\(/, theme);
  }
});

// WCAG relative luminance + contrast ratio.
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

for (const theme of ["dark", "light"] as const) {
  test(`${theme} palette meets WCAG AA: text 4.5:1, lines 3:1`, () => {
    const p = PALETTES[theme];
    const text: [string, string, string][] = [
      ["text", "bg", "everything"], ["textSecondary", "bg", "location, notes"],
      ["textMuted", "bg", "fee note"], ["textMuted", "bgSurface", "availability"],
      ["textMuted", "bgElevated", "Sold out / Event ended"], ["textSecondary", "warningBg", "ended note"],
      ["accentInk", "accent", "Buy button"], ["accentText", "bg", "privacy links"],
      ["error", "bg", "errors"], ["text", "inputBg", "typed input"],
    ];
    for (const [fg, bg, where] of text) {
      const k = fg as keyof typeof p, g = bg as keyof typeof p;
      assert.ok(contrast(p[k], p[g]) >= 4.5, `${fg} on ${bg} (${where}): ${contrast(p[k], p[g]).toFixed(2)}`);
    }
    // A field's edge and the accent mark carry meaning; the banners' hairlines do not
    // (their text does), so warningBorder is free to stay a tint.
    for (const [fg, bg] of [["accentLine", "bg"], ["inputBorder", "inputBg"], ["warning", "bg"]] as const) {
      assert.ok(contrast(p[fg], p[bg]) >= 3, `${fg} on ${bg}: ${contrast(p[fg], p[bg]).toFixed(2)}`);
    }
  });
}
