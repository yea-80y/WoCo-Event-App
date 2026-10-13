/**
 * The static iPhone check page (`public/passkey-check.html`): a child of
 * woco.eth.limo asking for a woco.eth.limo passkey, with woco.eth.limo itself as the
 * control. Its verdict logic is evaluated here exactly as shipped (the block between
 * the VERDICT markers), and the page is held to the promise it makes: it can never
 * yield an account key and loads nothing from elsewhere.
 *
 * MUTATION: drop the leading "." in roleFor's suffix test and "xwoco.eth.limo" reads
 * as a child - the role test goes red; swap the test-role branches and the verdict
 * test goes red; add `extensions: { prf: ... }` to the request and the safety test
 * goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../public/passkey-check.html", import.meta.url), "utf8");
const script = html.slice(html.indexOf("<script>"), html.indexOf("</script>"));
const block = script.slice(script.indexOf("// VERDICT-START"), script.indexOf("// VERDICT-END"));
// Our own shipped file, run in an empty sandbox (no globals) - nothing outside the repo is evaluated.
const { roleFor, verdictFor } = runInNewContext(`${block}; ({ roleFor, verdictFor })`, {}) as {
  roleFor: (h: string) => string;
  verdictFor: (role: string, outcome: string) => { tone: string; text: string };
};

test("the passkey host is the control, any child of it the test, anything else neither", () => {
  assert.equal(roleFor("woco.eth.limo"), "control");
  for (const h of ["app.woco.eth.limo", "rita.woco.eth.limo"]) assert.equal(roleFor(h), "test", h);
  for (const h of ["xwoco.eth.limo", "woco.eth.limo.evil.example", "gateway.woco-net.com", "localhost"]) {
    assert.equal(roleFor(h), "other", h);
  }
});

test("verdicts: on a child, a sheet means OPEN and a SecurityError means BLOCKED", () => {
  assert.equal(verdictFor("test", "security").tone, "good");
  assert.match(verdictFor("test", "security").text, /^BLOCKED/);
  for (const o of ["sheet", "assertion"]) {
    assert.equal(verdictFor("test", o).tone, "bad", o);
    assert.match(verdictFor("test", o).text, /^OPEN/);
  }
  assert.equal(verdictFor("control", "sheet").tone, "good");
  assert.match(verdictFor("control", "security").text, /^Control refused/);
  for (const role of ["test", "control"]) {
    assert.match(verdictFor(role, "nosheet").text, /tap Run the check again/, `${role}: no sheet is never a result`);
  }
});

test("the page can never yield an account key, and loads nothing from elsewhere", () => {
  assert.ok(!/extensions\s*:/.test(script), "no WebAuthn extensions - in particular no PRF");
  assert.ok(!/allowCredentials/.test(script), "no credential is targeted");
  assert.ok(!/(fetch|XMLHttpRequest|sendBeacon|localStorage|indexedDB)\b/.test(script), "nothing is sent or kept");
  assert.ok(!/(src|href)\s*=\s*["']https?:/i.test(html), "self-contained: no external scripts, styles or images");
  assert.ok(!html.includes("—"), "owner copy: spaced hyphen, never an em dash");
  assert.match(script, /rpId:\s*RP_ID/);
  assert.match(block, /var RP_ID = "woco\.eth\.limo";/);
});
