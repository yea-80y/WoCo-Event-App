/**
 * Home-screen install. The deploy's `<base href>` points relative URLs at one
 * deploy's immutable collection, so a manifest resolved against it would pin every
 * installed icon to that build forever (gateway) or be refused by the CSP
 * (eth.limo). These tests pin the manifest to the page's own host and app root,
 * and pin the manifest's paths to stay relative to it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { appRoot, manifestHref, MANIFEST_FILE } from "../src/lib/pwa/manifest-link.js";

const FEED = "a".repeat(64);
const publicDir = new URL("../public/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL(MANIFEST_FILE, publicDir), "utf-8"));
const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf-8");
const mainTs = readFileSync(new URL("../src/main.ts", import.meta.url), "utf-8");

test("the manifest resolves to the stable app root on the host that served the page", () => {
  const cases: Array<[string, string]> = [
    [`https://gateway.woco-net.com/bzz/${FEED}/`, `https://gateway.woco-net.com/bzz/${FEED}/manifest.json`],
    [`https://gateway.woco-net.com/bzz/${FEED}/#/event/x?y=1`, `https://gateway.woco-net.com/bzz/${FEED}/manifest.json`],
    [`https://gateway.woco-net.com/bzz/${FEED}`, `https://gateway.woco-net.com/bzz/${FEED}/manifest.json`],
    [`https://gateway.woco-net.com/bzz/${FEED}/deep/path?q=1`, `https://gateway.woco-net.com/bzz/${FEED}/manifest.json`],
    ["https://gateway.woco-net.com/bzz/woco.eth/", "https://gateway.woco-net.com/bzz/woco.eth/manifest.json"],
    ["https://woco.eth.limo/", "https://woco.eth.limo/manifest.json"],
    ["https://woco.eth.limo/#/build", "https://woco.eth.limo/manifest.json"],
    ["https://woco.eth.limo/some/path", "https://woco.eth.limo/manifest.json"],
    ["http://localhost:5173/?r=%2Fevent", "http://localhost:5173/manifest.json"],
  ];
  for (const [page, expected] of cases) assert.equal(manifestHref(page), expected, page);
  assert.equal(appRoot("https://woco.eth.limo/x/bzz/y/"), "https://woco.eth.limo/");
});

test("the manifest href is absolute, so the deploy's <base href> can never redirect it", () => {
  const href = manifestHref(`https://gateway.woco-net.com/bzz/${FEED}/`);
  assert.match(href, /^https:\/\//);
  assert.ok(!/<link[^>]+rel=["']manifest["']/i.test(indexHtml), "a static manifest link in index.html resolves against the deploy's <base href> and pins installs to one build");
});

// Reads the first `import` line, so an `import type` placed above it would fail this - move it below.
test("main.ts imports the manifest link first, before any other boot code", () => {
  const firstImport = mainTs.match(/^import\s+[^\n]*$/m)?.[0] ?? "";
  assert.match(firstImport, /lib\/pwa\/manifest-link/);
});

test("the manifest's start_url, scope and icons are relative, so they resolve to the stable root", () => {
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  // id resolves against start_url's ORIGIN: "./" would collide with any other app on the gateway.
  assert.equal(manifest.id, "woco-app");
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.name && manifest.short_name);
  for (const icon of manifest.icons) {
    assert.ok(!/^(?:[a-z]+:|\/)/i.test(icon.src), `icon ${icon.src} must be relative to the manifest`);
    assert.ok(existsSync(new URL(icon.src, publicDir)), `missing ${icon.src}`);
  }
  const sizes = (purpose: string) => manifest.icons.filter((i: { purpose: string }) => i.purpose === purpose).map((i: { sizes: string }) => i.sizes);
  assert.ok(sizes("any").includes("192x192") && sizes("any").includes("512x512"), "Chrome needs 192 and 512 icons to install");
  assert.ok(sizes("maskable").length > 0);
});

test("index.html carries the iOS home-screen tags, and its touch icon exists", () => {
  for (const tag of ["theme-color", "apple-mobile-web-app-capable", "apple-mobile-web-app-title"]) {
    assert.match(indexHtml, new RegExp(`<meta name="${tag}"`));
  }
  const touch = indexHtml.match(/<link rel="apple-touch-icon" href="\.\/([^"]+)"/);
  assert.ok(touch, "no apple-touch-icon");
  assert.ok(existsSync(new URL(touch[1], publicDir)));
});

test("no copy breaks the house rules", () => {
  assert.ok(!/—/.test(JSON.stringify(manifest)));
});
