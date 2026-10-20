/**
 * Text on an accent fill (owner, 2026-10-20: button text on the event page and
 * in event creation read white on the lime accent). The ink rules run under
 * Node; the components declare `$state`, which Node cannot load, so their CSS is
 * checked by SOURCE SCAN.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { accentInk, contrast, parseColor, DARK_INK, LIGHT_INK } from "../src/lib/utils/accent-ink.js";

const SRC = new URL("../src/", import.meta.url).pathname;
const read = (p: string) => readFileSync(SRC + p, "utf-8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");
const style = (p: string) => code(read(p).match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? "");
const ratio = (ink: string, fill: string) => contrast(parseColor(ink)!, parseColor(fill)!);

test("colours parse from hex (3, 4, 6, 8 digits) and rgb(); anything else is null", () => {
  assert.deepEqual(parseColor("#C7F23A"), [199, 242, 58]);
  assert.deepEqual(parseColor("#fff"), [255, 255, 255]);
  assert.deepEqual(parseColor("#ffff"), [255, 255, 255]);
  assert.deepEqual(parseColor("#2563ebcc"), [37, 99, 235]);
  assert.deepEqual(parseColor(" rgb(212, 175, 55) "), [212, 175, 55]);
  assert.deepEqual(parseColor("rgba(0 0 0 / 50%)"), [0, 0, 0]);
  assert.equal(parseColor("gold"), null);
  assert.equal(parseColor("#12345"), null);
});

test("the WoCo lime takes dark ink - white on it is 1.3:1", () => {
  assert.equal(accentInk("#C7F23A", "#D6FF45"), DARK_INK);
  assert.ok(ratio(LIGHT_INK, "#C7F23A") < 1.5);
  assert.ok(ratio(DARK_INK, "#C7F23A") > 15);
});

test("each site template's accent gets the ink that reads on its fill AND its hover fill", () => {
  // pub-venue gold: white was 2.1:1.
  assert.equal(accentInk("#d4af37", "#b8962b"), DARK_INK);
  // clean-modern blue: dark ink would be 3.8:1, white is 5.2:1.
  assert.equal(accentInk("#2563eb", "#1d4ed8"), LIGHT_INK);
  // nightlife purple: dark wins on the fill but loses on the hover, so white.
  assert.equal(accentInk("#a855f7", "#9333ea"), LIGHT_INK);
  // the shop template is WoCo's own lime.
  assert.equal(accentInk("#C7F23A", "#B4DE2E"), DARK_INK);
});

test("an unparseable fill is ignored, and with none the ink is dark", () => {
  assert.equal(accentInk("#d4af37", "not-a-colour"), DARK_INK);
  assert.equal(accentInk("not-a-colour"), DARK_INK);
});

test("a deployed site sets --accent-ink from its palette, with a default before the theme lands", () => {
  const app = code(read("MultiSiteApp.svelte"));
  assert.match(app, /setProperty\('--accent-ink', accentInk\(palette\.accent, palette\.accentHover\)\)/);
  assert.match(code(read("multi-site.css")), /--accent-ink:\s*#0B0B09;/);
});

test("the event page's buy buttons use the accent ink, never white", () => {
  for (const [file, selector] of [
    ["lib/attendee/events/claim/StripePayPanel.svelte", ".stripe-btn"],
    ["lib/attendee/events/claim/OrderForm.svelte", ".stripe-btn"],
    ["lib/attendee/events/claim/StripeSuccessCard.svelte", ".ses-done"],
    ["lib/components/site/EventPage.svelte", ".get-tickets-btn--active"],
    ["SiteApp.svelte", ".sign-in-cta"],
  ] as const) {
    const rule = style(file).match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`))?.[1];
    assert.ok(rule, `${file} ${selector}`);
    assert.match(rule!, /(?<![-\w])color:\s*var\(--accent-ink\);/, `${file} ${selector}`);
  }
});
