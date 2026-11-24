/**
 * The Keep link's secret leaves the address bar before anything reads the hash
 * (`src/lib/holding/keep-capture.ts`, wired first in the router's `update()`):
 * spec-receipt-note 5.2, Fable condition 2.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { holdingKeepFragment } from "@woco/shared/holding/pickup";
import { holdKeepLink, onKeepLink, stripKeepLink, takeKeepLink } from "../src/lib/holding/keep-capture.ts";

const R = new Uint8Array(32).fill(7);
const ROOT = "ab".repeat(32);

function at(href: string) {
  const url = new URL(href);
  const replaced: string[] = [];
  const got = stripKeepLink({ hash: url.hash, href: url.href }, (u) => replaced.push(u));
  return { got, replaced };
}

test("a Keep link: the address becomes #/keep, nothing else changes, the fragment is handed back", () => {
  const fragment = holdingKeepFragment(R, ROOT);
  const { got, replaced } = at(`https://woco.eth.limo/?x=1${fragment}`);
  assert.equal(got, fragment);
  assert.deepEqual(replaced, ["https://woco.eth.limo/?x=1#/keep"]);
  assert.ok(!replaced[0]!.includes("k="), "the secret is gone from the address");
  assert.ok(!replaced[0]!.includes(ROOT), "and so is the box's root");
});

test("a malformed Keep link is stripped too: whatever follows #/keep? never stays in the bar", () => {
  const { got, replaced } = at("https://app.example/#/keep?k=short&b=zz");
  assert.equal(got, "#/keep?k=short&b=zz");
  assert.deepEqual(replaced, ["https://app.example/#/keep"]);
});

test("anything else is left alone", () => {
  for (const href of ["https://app.example/#/keep", "https://app.example/#/tickets", "https://app.example/", "https://app.example/#/keeper?k=1", "https://app.example/#/event/x?k=1"]) {
    const { got, replaced } = at(href);
    assert.equal(got, null, href);
    assert.deepEqual(replaced, [], href);
  }
});

test("held once: the page takes it, and it is not kept after; a page already open is told", () => {
  let told = 0;
  const off = onKeepLink(() => told++);
  holdKeepLink("#/keep?k=a");
  assert.equal(told, 1);
  assert.equal(takeKeepLink(), "#/keep?k=a");
  assert.equal(takeKeepLink(), null);
  off();
  holdKeepLink("#/keep?k=b");
  assert.equal(told, 1, "unsubscribed");
  assert.equal(takeKeepLink(), "#/keep?k=b");
});

test("the router strips FIRST in update(), before any hash read, and holds only while receipts are on", () => {
  const src = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "../src/lib/router/router.svelte.ts"), "utf8");
  const update = src.slice(src.indexOf("function update() {"), src.indexOf("\nif (typeof window"));
  const strip = update.indexOf("stripKeepLink(window.location");
  assert.ok(strip > 0, "update() strips");
  assert.ok(strip < update.indexOf("parseHash()"), "before the referral capture reads the hash");
  assert.ok(strip < update.indexOf("matchRoute("), "before the route is matched");
  assert.match(update, /window\.history\.replaceState\(window\.history\.state, "", new URL\(url, window\.location\.href\)\.href\)/, "replaced, never a new history entry");
  assert.match(update, /if \(keep && FEATURES\.holdingReceiptsAllowed\) holdKeepLink\(keep\);/);
  assert.match(src, /if \(path === "\/keep" && FEATURES\.holdingReceiptsAllowed\) return \{ route: "keep"/);
  // Eager: the capture module imports nothing (no parse, no storage, no network on load).
  const capture = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "../src/lib/holding/keep-capture.ts"), "utf8");
  assert.doesNotMatch(capture, /^\s*import\s/m);
  assert.doesNotMatch(capture, /\bimport\(/);
});
