/**
 * The buy-flow rules, pinned. Each test corresponds to a way the widget
 * could sell something it must not, send a body the server would misread,
 * or let a broken seat-hold service block a sale it cannot protect.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { listKeeps, marketingChoice, marketingWording, shownMarketingMode, type OrderField, type PaymentConfig } from "@woco/shared";
import {
  isMarketingRefusal,
  seriesPayable,
  validateBuyPanel,
  maxSelectableQty,
  buildOrderPayload,
  buildCheckoutBody,
  staleOrderKeyRef,
  reserveOutcome,
  MAX_QTY,
} from "../src/checkout.js";

const stripePayment = (over: Partial<PaymentConfig> = {}): PaymentConfig => ({
  price: "12.00",
  currency: "GBP",
  stripeEnabled: true,
  cryptoEnabled: false,
  ...over,
} as PaymentConfig);

// ---------------------------------------------------------------------------
// Rule 1 — only a series a card checkout can complete gets a buy button
// ---------------------------------------------------------------------------

test("a Stripe-enabled priced series is payable", () => {
  assert.equal(seriesPayable(stripePayment()), true);
});

test("no payment config at all is not payable (pre-#141 events, stale cache)", () => {
  assert.equal(seriesPayable(undefined), false);
});

test("a zero-price series is not payable", () => {
  assert.equal(seriesPayable(stripePayment({ price: "0" })), false);
});

test("a crypto-only series is not payable while the crypto rail is off", () => {
  assert.equal(
    seriesPayable(stripePayment({ stripeEnabled: false, cryptoEnabled: true })),
    false,
  );
});

// ---------------------------------------------------------------------------
// Rule 2 — the wire body matches what create-checkout destructures
// ---------------------------------------------------------------------------

const baseInputs = {
  eventId: "ev1",
  seriesId: "s1",
  claimerEmail: "a@b.co",
  quantity: 1,
  marketing: marketingChoice("consent", false, "embed", marketingWording("consent", 2, undefined, listKeeps([]))!),
  pageUrl: "https://venue.example/tickets",
};

test("quantity 1 is omitted from the body (server default), >1 is sent", () => {
  assert.equal("quantity" in buildCheckoutBody(baseInputs), false);
  assert.equal(buildCheckoutBody({ ...baseInputs, quantity: 3 }).quantity, 3);
});

test("the marketing choice is always sent - mode, box, version, surface and words - so an untouched box is never 'not asked'", () => {
  const consentWords = { box: "Email me about future events from this organiser. We'll keep your email for this. You can unsubscribe at any time." };
  assert.deepEqual(buildCheckoutBody(baseInputs).marketing, { mode: "consent", ticked: false, version: 2, surface: "embed", wording: consentWords });
  const ownWords = marketingWording("own-events", 2, "P", { name: true, answers: [] })!;
  const own = marketingChoice("own-events", false, "embed", ownWords);
  assert.deepEqual(buildCheckoutBody({ ...baseInputs, marketing: own }).marketing, { mode: "own-events", ticked: false, version: 2, surface: "embed", wording: ownWords });
  assert.equal("marketingConsent" in buildCheckoutBody(baseInputs), false, "the pre-2026-10-14 field is gone");
});

test("the mode comes from claim-status; anything but own-events reads as consent mode", () => {
  assert.equal(shownMarketingMode({ marketingMode: "own-events" }), "own-events");
  for (const st of [null, undefined, {}, { marketingMode: "consent" }, { marketingMode: "OWN-EVENTS" }, { marketingMode: 1 }]) {
    assert.equal(shownMarketingMode(st as { marketingMode?: unknown } | null), "consent");
  }
  assert.equal(isMarketingRefusal({ ok: false, code: "MARKETING_MODE_CHANGED" }), true);
  assert.equal(isMarketingRefusal({ ok: false, code: "MARKETING_WORDING_CHANGED" }), true);
  assert.equal(isMarketingRefusal({ ok: false, code: "ORDER_KEY_STALE" }), false);
});

const widget = readFileSync(new URL("../src/components/woco-tickets.ts", import.meta.url), "utf-8");

test("the embed renders the control in the claim-status mode: own-events sentence + 'Don't email me', or consent's box", () => {
  const render = widget.slice(widget.indexOf("private renderConsent("), widget.indexOf("private get hasOrderForm"));
  assert.match(render, /const mode = shownMarketingMode\(st\.status\);/);
  // The words name what the list keeps from this event's own questions, and are
  // written back so checkout sends exactly what was rendered.
  // One keep rule for both boxes (owner 2026-10-15): nothing from claim-status narrows it.
  assert.match(render, /const w = marketingWording\(mode, MARKETING_CURRENT_VERSION\[mode\], name, listKeeps\(this\.event\?\.orderFields\)\)!;\n\s*st\.marketing\.wording = w;/);
  assert.doesNotMatch(widget, /tailored/i);
  assert.match(render, /\$\{w\.sentence \? `<div class="marketing-sentence">\$\{this\.esc\(w\.sentence\)\}<\/div>` : ""\}/);
  assert.match(render, /<span>\$\{this\.esc\(w\.box\)\}<\/span>/);
  // Never pre-ticked: checked only from what the buyer did, reset when the mode changes.
  assert.match(render, /if \(st\.marketing\.mode !== mode\) st\.marketing = \{ mode, ticked: false \};/);
  assert.match(render, /\$\{st\.marketing\.ticked \? "checked" : ""\}/);
  // And it is in every buy panel, above the pay button.
  const panel = widget.slice(widget.indexOf("private renderBuyPanel("), widget.indexOf("private renderSeries("));
  assert.ok(panel.indexOf("this.renderConsent(") > 0);
  assert.ok(panel.indexOf("this.renderConsent(") < panel.indexOf("Continue to payment"));
  assert.equal(widget.match(/freshSeriesState[\s\S]*?marketing: \{ mode: "consent", ticked: false \}/)?.length, 1);
});

test("the embed sends the mode it RENDERED, never one re-derived from a status that arrived later", () => {
  assert.match(widget, /marketing: marketingChoice\(st\.marketing\.mode, st\.marketing\.ticked, "embed", st\.marketing\.wording\)/);
  assert.match(widget, /if \(st\) st\.marketing\.ticked = el\.checked;/);
});

test("the embed: either marketing refusal re-reads claim-status and re-renders - it never retries the charge", () => {
  const branch = widget.slice(widget.indexOf("isMarketingRefusal(resp"));
  const body = branch.slice(0, branch.indexOf("return;"));
  assert.match(body, /await this\.refreshStatus\(seriesId\)/);
  assert.match(body, /this\.updateSeries\(seriesId\)/);
  assert.doesNotMatch(body, /handleCheckout|create-checkout/);
});

test("the page goes as pageUrl, and no returnUrl or cancelUrl is sent - the server derives both redirects from it (#567)", () => {
  const body = buildCheckoutBody({
    ...baseInputs,
    encryptedOrder: { ephemeralPublicKey: "e", iv: "i", ciphertext: "c" },
    reservationId: "r1",
  });
  assert.equal(body.pageUrl, "https://venue.example/tickets");
  assert.equal("returnUrl" in body, false);
  assert.equal("cancelUrl" in body, false);
});

test("with no known page, neither pageUrl nor cancelUrl is sent, so the server's WoCo pages apply", () => {
  const body = buildCheckoutBody({ ...baseInputs, pageUrl: undefined });
  assert.equal("pageUrl" in body, false);
  assert.equal("cancelUrl" in body, false);
});

test("absent encryptedOrder / reservationId are omitted, not sent as undefined", () => {
  const body = buildCheckoutBody(baseInputs);
  assert.equal("encryptedOrder" in body, false);
  assert.equal("reservationId" in body, false);
});

test("the sealed payload carries fields + seriesId + claimerEmail, the shape the dashboard decrypts", () => {
  assert.deepEqual(buildOrderPayload({ name: "Ada" }, "s1", "a@b.co"), {
    fields: { name: "Ada" },
    seriesId: "s1",
    claimerEmail: "a@b.co",
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — a failed hold only stops the sale when seats definitively ran out
// ---------------------------------------------------------------------------

test("a granted hold is used", () => {
  const o = reserveOutcome({ ok: true, data: { reservationId: "abc" } });
  assert.deepEqual(o, { kind: "reserved", reservationId: "abc" });
});

test("'Insufficient seats' blocks the purchase honestly", () => {
  const o = reserveOutcome({ ok: false, error: "Insufficient seats" });
  assert.equal(o.kind, "blocked");
});

test("a rate-limited hold proceeds without one — the hold service must not block a sale it cannot protect", () => {
  assert.equal(reserveOutcome({ ok: false, error: "Rate limit exceeded" }).kind, "proceed");
});

test("a dead reservation endpoint (network throw → null) proceeds without a hold", () => {
  assert.equal(reserveOutcome(null).kind, "proceed");
});

test("an ok response with no reservationId proceeds rather than sending a phantom id", () => {
  assert.equal(reserveOutcome({ ok: true, data: {} }).kind, "proceed");
});

// ---------------------------------------------------------------------------
// Rule 4 — quantity and email plumbing
// ---------------------------------------------------------------------------

test("quantity picker is capped by availability and by the server clamp", () => {
  assert.equal(maxSelectableQty(3), 3);
  assert.equal(maxSelectableQty(500), MAX_QTY);
  assert.equal(maxSelectableQty(0), 1); // sold-out cards never render the picker; floor stays sane
  assert.equal(maxSelectableQty(NaN), MAX_QTY); // unreadable count falls back to the server clamp
});

// ── #597: the buy panel reads the order form's email field ──────────────────

/** Stands in for a VERIFIED X-Wing order key (#642); the panel only checks presence. */
const KEY = new Uint8Array(1216).fill(7);
const EMAIL: OrderField = { id: "__email", type: "email", label: "Email", required: true };
const NAME: OrderField = { id: "name", type: "text", label: "Name", required: true };
const GUEST: OrderField = { id: "guest", type: "email", label: "Guest's email", required: false };
/** The confirm box repeats whichever address was typed unless a test says otherwise (#982). */
const panel = (
  fields: OrderField[] | undefined,
  formData: Record<string, string>,
  inlineEmail = "",
  key: Uint8Array | undefined = KEY,
  emailConfirm = formData.__email ?? inlineEmail,
) => validateBuyPanel({ fields, verifiedKey: key, formData, inlineEmail, emailConfirm });

test("the default order form's email field is the ticket address (the #597 dead-end)", () => {
  assert.deepEqual(panel([EMAIL, NAME], { __email: " buyer@example.com ", name: "Ann" }), { ok: true, email: "buyer@example.com" });
});

test("a blank email field is refused by its own label, even when the organiser left it optional", () => {
  // No wallet or account path here: that field is the only way a ticket arrives.
  const optional = { ...EMAIL, required: false, label: "Your email" };
  assert.deepEqual(panel([optional], {}), { ok: false, error: "Your email is required" });
});

test("an implausible email in the form names the field to fix", () => {
  assert.deepEqual(panel([EMAIL], { __email: "not-an-address" }), { ok: false, error: "Enter a valid email address in Email" });
});

test("an unlabelled field is named by its placeholder, never by its internal id", () => {
  const bare: OrderField = { id: "field_1727000000000", type: "text", label: "", required: true };
  assert.deepEqual(panel([bare], {}), { ok: false, error: "This field is required" });
  assert.deepEqual(panel([{ ...bare, placeholder: "Your name" }], {}), { ok: false, error: "Your name is required" });
});

test("errors come top to bottom, in the order the buyer sees the fields", () => {
  assert.deepEqual(panel([NAME, EMAIL], {}), { ok: false, error: "Name is required" });
  assert.deepEqual(panel([EMAIL, NAME], {}), { ok: false, error: "Email is required" });
});

test("with no email field in the form, the widget's own box is the address", () => {
  assert.deepEqual(panel([NAME], { name: "Ann" }, "me@example.com"), { ok: true, email: "me@example.com" });
  assert.deepEqual(panel([NAME], { name: "Ann" }, ""), { ok: false, error: "Enter a valid email address" });
  assert.deepEqual(panel(undefined, {}, " me@example.com "), { ok: true, email: "me@example.com" });
});

test("a guest's email field never becomes the ticket address", () => {
  assert.deepEqual(panel([GUEST], { guest: "friend@example.com" }, "me@example.com"), { ok: true, email: "me@example.com" });
});

test("a form that cannot be shown (no organiser key) falls back to the widget's box, never a dead-end", () => {
  const noKey = validateBuyPanel({ fields: [EMAIL], verifiedKey: undefined, formData: {}, inlineEmail: "me@example.com", emailConfirm: "me@example.com" });
  assert.deepEqual(noKey, { ok: true, email: "me@example.com" });
});

// ── #982: a typo'd address loses the ticket, so the buyer types it twice ────

test("a confirm box that does not match stops the purchase, on either address box", () => {
  const formMismatch = { ok: false, error: "The emails don't match" };
  assert.deepEqual(panel([EMAIL], { __email: "buyer@example.com" }, "", KEY, "buyr@example.com"), formMismatch);
  assert.deepEqual(panel([NAME], { name: "Ann" }, "me@example.com", KEY, "me@exmaple.com"), formMismatch);
  assert.deepEqual(panel(undefined, {}, "me@example.com", KEY, "me@exmaple.com"), formMismatch);
});

test("an empty confirm box asks for the address again", () => {
  const ask = { ok: false, error: "Confirm your email address" };
  assert.deepEqual(panel([EMAIL], { __email: "buyer@example.com" }, "", KEY, ""), ask);
  assert.deepEqual(panel(undefined, {}, "me@example.com", KEY, "  "), ask);
});

test("the confirm box matches trimmed and in any case", () => {
  assert.deepEqual(panel([EMAIL], { __email: "Buyer@Example.com" }, "", KEY, " buyer@example.COM "), { ok: true, email: "Buyer@Example.com" });
});

test("the form's confirm box is checked where it sits, under the email field", () => {
  // Name comes after the email + confirm pair on screen, so its message waits.
  assert.deepEqual(panel([EMAIL, NAME], { __email: "buyer@example.com" }, "", KEY, "buyr@example.com"), { ok: false, error: "The emails don't match" });
  assert.deepEqual(panel([NAME, EMAIL], { __email: "buyer@example.com" }, "", KEY, "buyr@example.com"), { ok: false, error: "Name is required" });
});

test("a blank address names the missing address, never the confirm box", () => {
  assert.deepEqual(panel([EMAIL], {}, "", KEY, "buyer@example.com"), { ok: false, error: "Email is required" });
  assert.deepEqual(panel(undefined, {}, "", KEY, "me@example.com"), { ok: false, error: "Enter a valid email address" });
});

test("the sealed key is declared only with a box (#186)", () => {
  const box = { v: 2, enc: "ab", ct: "cd" } as unknown as NonNullable<Parameters<typeof buildCheckoutBody>[0]["encryptedOrder"]>;
  const k = "0a".repeat(32);
  assert.equal(buildCheckoutBody({ ...baseInputs, encryptedOrder: box, encryptionKeyRef: k }).encryptionKeyRef, k);
  assert.equal("encryptionKeyRef" in buildCheckoutBody({ ...baseInputs, encryptionKeyRef: k }), false);
});

test("a stale-key refusal names a key to re-seal to - only a well-formed, different one", () => {
  const k0 = "0a".repeat(32);
  const k1 = "1b".repeat(32);
  assert.equal(staleOrderKeyRef({ ok: false, code: "ORDER_KEY_STALE", encryptionKeyRef: k1 }, k0), k1);
  assert.equal(staleOrderKeyRef({ ok: false, code: "ORDER_KEY_STALE", encryptionKeyRef: k0 }, k0), null, "the same key again changes nothing");
  assert.equal(staleOrderKeyRef({ ok: false, code: "ORDER_KEY_STALE", encryptionKeyRef: "XYZ" }, k0), null);
  assert.equal(staleOrderKeyRef({ ok: false, code: "OTHER", encryptionKeyRef: k1 }, k0), null);
  assert.equal(staleOrderKeyRef({ ok: false, code: "ORDER_KEY_STALE" }, k0), null);
});

test("#982: the widget shows Confirm email under each address box and checks the box the buyer typed in", () => {
  const fields = widget.slice(widget.indexOf("private renderOrderFields("), widget.indexOf("private renderBuyPanel("));
  assert.match(fields, /if \(f\.id === ORDER_EMAIL_FIELD_ID\) fieldsHtml \+= this\.renderEmailConfirm\(seriesId, st\);/);
  const panel = widget.slice(widget.indexOf("private renderBuyPanel("), widget.indexOf("private renderSeries("));
  const box = panel.indexOf("data-email-input=");
  assert.ok(box > 0 && panel.indexOf("this.renderEmailConfirm(s.seriesId, st)", box) > box, "under the widget's own box");
  assert.ok(panel.indexOf("this.renderEmailConfirm(s.seriesId, st)") < panel.indexOf("Continue to payment"));
  assert.match(widget, /inlineEmail: st\.email,\n\s*emailConfirm: st\.emailConfirm,/);
  assert.match(widget, /st\.emailConfirm = el\.value;/);
  // Cancel forgets it with the address it confirmed.
  assert.match(widget, /st\.email = "";\n\s*st\.emailConfirm = "";/);
});
