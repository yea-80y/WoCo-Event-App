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

/** Rules (selector, body) in a component's <style>, comma lists split out. */
function rules(file: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of style(file).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const sel of m[1].split(",")) out.push([sel.trim().replace(/\s+/g, " "), m[2]]);
  }
  return out;
}

test("a selected chip keeps its ink under a phone's sticky hover - the hover's text colour skips it", () => {
  // A tap leaves :hover on the tapped element, and these hover rules outrank
  // the selected class, so the chip went to the bone text colour on lime.
  for (const [file, base, selected] of [
    ["lib/creator/events/GenreTagPicker.svelte", ".pill", ".pill--active"],
    ["lib/creator/builder/SubENSPicker.svelte", ".mode-btn", ".mode-btn--active"],
    ["lib/creator/events/TicketSeriesEditor.svelte", ".fee-mode-btn", ".fee-mode-btn--active"],
  ] as const) {
    const all = rules(file);
    const fill = all.find(([sel]) => sel === selected);
    assert.ok(fill, `${file} ${selected}`);
    assert.match(fill![1], /(?<![-\w])color:\s*var\(--accent-ink\);/, `${file} ${selected}`);
    const hovers = all.filter(([sel, body]) =>
      sel.startsWith(base) && sel.includes(":hover") && /(?<![-\w])color:/.test(body));
    assert.ok(hovers.length > 0, `${file} has a ${base} hover colour`);
    for (const [sel] of hovers) {
      if (sel.startsWith(selected)) continue;
      assert.ok(sel.includes(`:not(${selected})`), `${file}: "${sel}" must skip ${selected}`);
    }
  }
});

test("event creation's accent buttons use the accent ink, never white", () => {
  for (const [file, selector] of [
    ["lib/creator/events/PublishButton.svelte", ".publish-btn"],
    ["lib/creator/events/StripeVerifyGate.svelte", ".setup-btn"],
    ["lib/creator/events/TicketSeriesEditor.svelte", ".crypto-recipient-btn"],
    ["lib/creator/events/ImportUrlPanel.svelte", ".import-btn"],
    ["lib/creator/events/ImportUrlPanel.svelte", ".import-apply-btn"],
    ["lib/creator/dashboard/StripeConnectModal.svelte", ".modal-cta--login"],
  ] as const) {
    const rule = rules(file).find(([sel]) => sel === selector);
    assert.ok(rule, `${file} ${selector}`);
    assert.match(rule![1], /(?<![-\w])color:\s*var\(--accent-ink\);/, `${file} ${selector}`);
  }
});

test("no rule anywhere in the app puts white or the page text colour on an accent fill", async () => {
  const { readdirSync } = await import("node:fs");
  const files = (readdirSync(SRC, { recursive: true }) as string[]).filter((f) => f.endsWith(".svelte"));
  const ACCENT_FILL = /^var\(--accent(-hover|-press)?(,[^)]*)?\)$/;
  const LIGHT_TEXT = /^(#fff|#ffffff|white|var\(--text(-primary|-secondary)?(,[^)]*)?\))$/i;
  const bad: string[] = [];
  for (const file of files) {
    if (/var\(--accent-ink,\s*#fff/i.test(style(file))) bad.push(`${file}: var(--accent-ink, #fff)`);
    for (const [sel, body] of rules(file)) {
      const bg = [...body.matchAll(/background(?:-color)?:\s*([^;]+);/g)].pop()?.[1].trim();
      const fg = [...body.matchAll(/(?<![-\w])color:\s*([^;]+);/g)].pop()?.[1].trim();
      if (bg && fg && ACCENT_FILL.test(bg) && LIGHT_TEXT.test(fg)) bad.push(`${file}: ${sel}`);
    }
  }
  assert.deepEqual(bad, []);
});
