/**
 * The checkout's marketing control on every main-app surface, in both modes
 * (soft opt-in, owner 2026-10-14). The shared control is rendered for real
 * (svelte/compiler + svelte/server); the panels and ClaimButton by SOURCE SCAN
 * (they declare `$state` and import other components, which Node cannot load).
 *
 * MUTATIONS (each went red, then restored): the control pre-ticked; the sentence
 * dropped in own-events mode; the pay panel without the control (the pre-2026-10-14
 * gap); the control below the pay button; ClaimButton sending a mode it did not
 * render, or keeping a box ticked across a mode change; the 409 not re-reading
 * claim-status; the api client dropping `marketing` from the body; ClaimButton
 * building the words from anything but the event's questions, or sending other
 * words than the panels render; the wording-changed 409 not re-reading.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(here, "../src/");
const read = (p: string) => readFileSync(SRC + p, "utf-8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// --- the control, rendered for real ----------------------------------------

const { compile } = await import("svelte/compiler");
const { render } = await import("svelte/server");
// Inside the package, so the compiled module resolves `svelte/internal/server`; removed after.
const out = mkdtempSync(join(here, "../node_modules/.marketing-control-render-"));
test.after(() => rmSync(out, { recursive: true, force: true }));
const compiled = compile(read("lib/attendee/events/claim/MarketingControl.svelte"), { generate: "server", filename: "MarketingControl.svelte" });
const file = join(out, "MarketingControl.js");
writeFileSync(file, compiled.js.code);
const Control = (await import(pathToFileURL(file).href)).default;

const { marketingWording, listKeeps } = await import("@woco/shared");
const words = (mode: "consent" | "own-events", organiser?: string, labels: string[] = []) =>
  marketingWording(mode, 2, organiser, listKeeps(labels.map((label) => ({ id: label, type: "text" as const, label, required: false }))))!;

const html = (props: Record<string, unknown>) =>
  render(Control, { props: { onTickedChange: () => {}, ...props } })
    .body.replace(/ class="svelte-[a-z0-9]+"/g, "")
    .replace(/ svelte-[a-z0-9]+"/g, '"')
    .replace(/<!--[^>]*-->/g, "");

test("own-events: the sentence names the organiser and what is kept, and the box is an unticked 'Don't email me'", () => {
  const shown = html({ wording: words("own-events", "Punk Pub Ltd", ["Full name", "Town"]), ticked: false });
  assert.ok(shown.includes("We'll email you about similar events from Punk Pub Ltd, and keep your email, name and your answers to: Town for this. You can unsubscribe from any email."));
  assert.ok(shown.includes("Don't email me about similar events"));
  assert.doesNotMatch(shown, /checked/);
  assert.doesNotMatch(shown, /Email me about future events/);
});

test("consent: an unticked 'Email me' box naming what is kept, and no sentence", () => {
  const shown = html({ wording: words("consent", "Punk Pub Ltd"), ticked: false });
  assert.ok(shown.includes("Email me about future events from this organiser. We'll keep your email for this. You can unsubscribe at any time."));
  assert.doesNotMatch(shown, /checked/);
  assert.doesNotMatch(shown, /similar events|Don't email me/);
});

test("the box shows what the buyer did, in either mode", () => {
  assert.match(html({ wording: words("consent"), ticked: true }), /checked/);
  assert.match(html({ wording: words("own-events", "P"), ticked: true }), /checked/);
});

// --- both main-app panels show it, above the pay button ---------------------

for (const [file, button] of [
  ["lib/attendee/events/claim/OrderForm.svelte", "Continue to payment"],
  ["lib/attendee/events/claim/StripePayPanel.svelte", "Pay with card"],
] as const) {
  test(`${file.split("/").pop()} renders the control above its pay button, with the words it is given`, () => {
    const src = code(read(file));
    const markup = src.slice(src.indexOf("</script>"));
    const at = markup.indexOf("<MarketingControl");
    assert.ok(at > 0, "the control is rendered");
    assert.ok(at < markup.indexOf(button), "above the pay button");
    // Unconditional: no {#if} hides it on this panel.
    const before = markup.slice(0, at);
    assert.equal((before.match(/\{#if/g) ?? []).length - (before.match(/\{\/if\}/g) ?? []).length, 0);
    assert.match(markup, /wording=\{marketingWording\}/);
    assert.match(markup, /ticked=\{marketingTicked\}/);
    assert.doesNotMatch(src, /MARKETING_CONSENT_NOTICE|marketingWording\(/, "the words come from ClaimButton, never rebuilt here");
  });
}

// --- ClaimButton: the mode it renders is the mode it sends -------------------

test("ClaimButton takes the mode from claim-status and sends the mode, box, surface and words it showed", () => {
  const src = code(read("lib/attendee/events/ClaimButton.svelte"));
  assert.match(src, /const marketingMode = \$derived<MarketingMode>\(shownMarketingMode\(status\)\)/);
  // One object, built from the event's own questions, rendered by both panels and sent.
  assert.match(src, /const marketingWording = \$derived\(\s*buildMarketingWording\(marketingMode, MARKETING_CURRENT_VERSION\[marketingMode\], marketingOrganiser, listKeeps\(orderFields\)\)!,\s*\)/);
  assert.match(src, /marketing: marketingChoice\(marketingMode, marketingTicked, showOrderForm \? "order-form" : "pay-panel", marketingWording\)/);
  // Both panels get the same state.
  assert.equal(src.match(/onMarketingChange=\{setMarketingTicked\}/g)?.length, 2);
  assert.equal(src.match(/\{marketingWording\}/g)?.length, 2);
});

test("ClaimButton: a box ticked under one mode reads unticked under the other", () => {
  const src = code(read("lib/attendee/events/ClaimButton.svelte"));
  assert.match(src, /const marketingTicked = \$derived\(marketingBox\.mode === marketingMode && marketingBox\.ticked\)/);
  assert.match(src, /marketingBox = \{ mode: marketingMode, ticked \}/);
  assert.match(src, /\$state<\{ mode: MarketingMode; ticked: boolean \}>\(\{ mode: "consent", ticked: false \}\)/);
});

test("ClaimButton: either marketing refusal re-reads claim-status and asks again - it never retries the charge", () => {
  const src = code(read("lib/attendee/events/ClaimButton.svelte"));
  const branch = src.slice(src.indexOf("isMarketingChanged(err.code)"));
  const body = branch.slice(0, branch.indexOf("}") + 1);
  assert.match(body, /await refreshStatusNow\(\)/);
  assert.doesNotMatch(body, /handleStripeCheckout|createCheckoutSession/);
});

test("the api client sends the choice as given, and surfaces the refusal code", () => {
  const src = code(read("lib/api/stripe.ts"));
  assert.match(src, /\.\.\.\(params\.marketing \? \{ marketing: params\.marketing \} : \{\}\)/);
  assert.match(src, /new CheckoutError\(data\.error \|\| "Failed to create checkout session", !!data\.gated, data\.code\)/);
  assert.doesNotMatch(src, /marketingConsent/);
});
