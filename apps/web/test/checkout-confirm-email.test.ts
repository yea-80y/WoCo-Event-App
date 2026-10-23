/**
 * #982: wherever the app collects the ticket's address, a Confirm email box, and
 * Pay waits for the two to match - a ticket's QR exists only in its email, so a
 * typo'd address loses the ticket. The rule itself is `buyerEmailConfirmed`
 * (packages/shared, tested there); these check that every surface applies it.
 *
 * TEXT checks on source: the repo has no component-test harness and this suite
 * runs under plain tsx (login-surface-registration.test.ts says why).
 *
 * MUTATION: drop the `emailConfirmed` line from formValid, the Pay-time check in
 * handleStripeCheckout, the panel's `!emailConfirmed` in `disabled`, either
 * `confirmBox` render in OrderForm, a blur callback, or send our own box's value
 * past `inlineEmail`, and a test here goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const markup = (src: string) => src.slice(src.indexOf("</script>"), src.indexOf("<style>"));
const claim = read("../src/lib/attendee/events/ClaimButton.svelte");
const form = markup(read("../src/lib/attendee/events/claim/OrderForm.svelte"));
const panel = markup(read("../src/lib/attendee/events/claim/StripePayPanel.svelte"));

test("the address to confirm is the box on screen, never a hidden one", () => {
  assert.match(claim, /const inlineEmail = \(link: boolean = linked\): string => \(!link && !hasEmailField \? stripeEmail\.trim\(\) : ""\);/);
  assert.match(claim, /const typedEmail = \$derived\(hasEmailField \? formData\[ORDER_EMAIL_FIELD_ID\] \?\? "" : inlineEmail\(\)\);/);
  assert.match(claim, /const emailConfirmed = \$derived\(buyerEmailConfirmed\(typedEmail, emailConfirm\)\);/);
});

test("our own box's value is sent only while it is on screen, so never unconfirmed", () => {
  // Typed, then signed in: the box hides and the gate lets Pay through, so the
  // value must not ride along as the ticket address or into the sealed order.
  assert.match(claim, /const email = getEmailFromForm\(\) \|\| inlineEmail\(linkAccount\) \|\| undefined;/);
  assert.match(claim, /getEmailFromForm\(\) \?\? inlineEmail\(link\),/);
  assert.match(claim, /getEmail: \(\) => getEmailFromForm\(\) \?\? inlineEmail\(\),/);
  assert.doesNotMatch(claim, /getEmailFromForm\(\) (\|\||\?\?) stripeEmail/);
});

test("leaving the confirm box shows any mismatch from then on", () => {
  assert.match(claim, /const emailMismatch = \$derived\(buyerEmailMismatch\(typedEmail, emailConfirm, emailConfirmSettled\)\);/);
  assert.equal(claim.match(/onEmailConfirmBlur=\{\(\) => \{ emailConfirmSettled = true; \}\}/g)?.length, 2, "both panels");
  assert.match(form, /onblur=\{onEmailConfirmBlur\}/);
  assert.match(panel, /onblur=\{onEmailConfirmBlur\}/);
});

test("the order form's Pay waits for the confirm box", () => {
  const body = claim.slice(claim.indexOf("const formValid = $derived(() => {"));
  assert.match(body.slice(0, body.indexOf("});")), /if \(!emailConfirmed\) return false;/);
  assert.match(form, /disabled=\{!formValid\(\)\}/);
});

test("Pay refuses an unconfirmed address, after the form is on screen", () => {
  const handler = claim.slice(claim.indexOf("async function handleStripeCheckout()"));
  const formOpens = handler.indexOf("showOrderForm = true;");
  const check = handler.indexOf("if (!emailConfirmed) {");
  const redirect = handler.indexOf("createCheckoutSession(");
  assert.ok(formOpens > 0 && check > formOpens && redirect > check, "open the form, then check, then pay");
});

test("the order form shows Confirm email under its email field, and under the fallback box", () => {
  const field = form.indexOf("{#if field.id === ORDER_EMAIL_FIELD_ID}");
  assert.ok(field > form.indexOf("{#each orderFields as field}") && field < form.lastIndexOf("{/each}"));
  assert.match(form.slice(field), /^\{#if field\.id === ORDER_EMAIL_FIELD_ID\}\s*(<!--[^]*?-->\s*)?\{@render confirmBox\(/);
  const fallback = form.indexOf("bind:value={stripeEmail}");
  assert.ok(fallback > 0 && form.indexOf("{@render confirmBox(true)}", fallback) > fallback);
  assert.match(form, /bind:value=\{emailConfirm\}/);
  assert.match(form, /\{#if emailMismatch\}<span class="field-error" id=\{mismatchId\} role="alert">The emails don't match<\/span>\{\/if\}/);
  assert.match(form, /aria-describedby=\{emailMismatch \? mismatchId : undefined\}/);
  // A filled optional field is starred too: Pay waits for its confirm box.
  assert.match(form, /confirmBox\(orderFieldRequired\(field, \{ canUseAccount: authConnected \}\) \|\| \(formData\[field\.id\] \?\? ""\)\.trim\(\)\.length > 0\)/);
});

test("the pay panel shows Confirm email under its email box, and its Pay waits for it", () => {
  assert.match(panel, /disabled=\{stripeLoading \|\| soldOut \|\| \(showEmailInput && !emailConfirmed\)\}/);
  const box = panel.indexOf("{#if showEmailInput}");
  const end = panel.indexOf("{/if}", panel.indexOf("{#if emailMismatch}"));
  const block = panel.slice(box, end);
  assert.ok(block.indexOf("value={stripeEmail}") < block.indexOf("value={emailConfirm}"), "confirm sits under the email box");
  assert.match(block, /onEmailConfirmChange/);
  assert.match(claim, /onEmailConfirmChange=\{\(v\) => \{ emailConfirm = v; \}\}/);
});
