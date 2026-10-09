/**
 * Organiser-typed links on WoCo sites (`site/safe-href.ts`). A site is served under
 * `<label>.woco.eth.limo`, where in an out-of-date browser any script can ask for the
 * visitor's woco.eth.limo passkey - so a link must never become script.
 *
 * MUTATION: allow "javascript:" in ALLOWED_SCHEMES and "never script" goes red; match
 * the scheme as text instead of parsing (drop `new URL`) and the obfuscated cases go
 * red; return the raw string instead of `url.href` and "the browser gets the parser's
 * serialisation" goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { safeHref, safeSwarmRef } from "../src/site/safe-href.js";

test("in-site routes and ordinary web, mail and phone links survive", () => {
  assert.equal(safeHref("#/whats-on"), "#/whats-on");
  assert.equal(safeHref("  #/events "), "#/events");
  assert.equal(safeHref("https://example.com/tickets"), "https://example.com/tickets");
  assert.equal(safeHref("http://example.com"), "http://example.com/");
  assert.equal(safeHref("mailto:hello@example.com"), "mailto:hello@example.com");
  assert.equal(safeHref("tel:+441234567890"), "tel:+441234567890");
});

test("never script, however it is spelled", () => {
  for (const raw of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "  javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "blob:https://example.com/x",
    "file:///etc/passwd",
  ]) {
    assert.equal(safeHref(raw), null, JSON.stringify(raw));
  }
});

test("relative and scheme-relative strings render as no link", () => {
  for (const raw of ["//evil.example/x", "/events", "events", "#whats-on", "", undefined, null]) {
    assert.equal(safeHref(raw as string | undefined | null), null, String(raw));
  }
});

test("the browser gets the parser's serialisation, not the raw string", () => {
  assert.equal(safeHref("HTTPS://Example.COM/a b"), "https://example.com/a%20b");
});

test("a background image reference is a Swarm reference or nothing", () => {
  const ref = "a".repeat(64);
  assert.equal(safeSwarmRef(ref), ref);
  for (const raw of ["a".repeat(63), `${"a".repeat(64)}) ; background:url(https://evil.example`, "", undefined]) {
    assert.equal(safeSwarmRef(raw as string | undefined), null);
  }
});
