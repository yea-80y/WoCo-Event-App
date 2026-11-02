/**
 * #1032 — the runtime release descriptor (v2: websites + single-event pages from
 * one commit) parses strictly: it names addresses a page will link and the server
 * will admit.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSiteRuntimeRelease,
  SITE_RUNTIME_FORMAT,
  SITE_RUNTIME_INDEX_DOCUMENT,
  SITE_RUNTIME_RELEASE_OWNER,
} from "../src/site/runtime-release.js";

const H = (c: string) => c.repeat(64);
const siteLine = () => ({
  dist: { files: 251, bytes: 8_900_000 },
  roots: {
    woco: {
      root: H("1"), edges: { "assets/": H("2"), "icons/": H("3") },
      files: { "logo.png": { ref: H("6"), contentType: "image/png" }, "app.webmanifest.json": { ref: H("7"), contentType: "application/json" } },
      indexDocument: "multi-site.html",
    },
    etherna: { root: H("4"), edges: { "assets/": H("5") }, files: {}, indexDocument: "multi-site.html" },
  },
});
const pageLine = () => ({
  dist: { files: 240, bytes: 8_700_000 },
  roots: {
    woco: { root: H("8"), edges: { "assets/": H("9"), "icons/": H("a") }, files: { "logo.png": { ref: H("6"), contentType: "image/png" } }, indexDocument: "site.html" },
    etherna: { root: H("b"), edges: { "assets/": H("c") }, files: {}, indexDocument: "site.html" },
  },
});
const good = () => ({
  format: SITE_RUNTIME_FORMAT,
  version: 3,
  commit: "a".repeat(40),
  builtAt: "2026-11-02T15:00:00.000Z",
  runtimes: { site: siteLine(), eventPage: pageLine() },
});
const withSiteRoots = (roots: unknown) => ({ ...good(), runtimes: { ...good().runtimes, site: { ...siteLine(), roots } } });

test("a well-formed descriptor parses to the same values, key order included", () => {
  assert.deepEqual(parseSiteRuntimeRelease(good()), good());
  assert.equal(JSON.stringify(parseSiteRuntimeRelease(good())), JSON.stringify(good()), "the publish script compares the JSON text");
  const { etherna: _e, ...wocoOnly } = siteLine().roots;
  assert.deepEqual(parseSiteRuntimeRelease(withSiteRoots(wocoOnly))?.runtimes.site.roots, wocoOnly, "etherna is optional");
});

test("both runtimes are required, and nothing else", () => {
  const { eventPage: _p, ...siteOnly } = good().runtimes;
  assert.equal(parseSiteRuntimeRelease({ ...good(), runtimes: siteOnly }), null, "a release without event pages is refused");
  const { site: _s, ...pageOnly } = good().runtimes;
  assert.equal(parseSiteRuntimeRelease({ ...good(), runtimes: pageOnly }), null);
  assert.equal(parseSiteRuntimeRelease({ ...good(), runtimes: { ...good().runtimes, shop: siteLine() } }), null);
  assert.equal(parseSiteRuntimeRelease({ ...good(), runtimes: { ...good().runtimes, site: { ...siteLine(), extra: 1 } } }), null);
});

test("each line's roots name that line's index document, and no other", () => {
  assert.deepEqual(SITE_RUNTIME_INDEX_DOCUMENT, { site: "multi-site.html", eventPage: "site.html" });
  const swapped = { ...good(), runtimes: { site: pageLine(), eventPage: siteLine() } };
  assert.equal(parseSiteRuntimeRelease(swapped), null, "a page runtime offered as the site runtime is refused");
  const roots = siteLine().roots;
  assert.equal(parseSiteRuntimeRelease(withSiteRoots({ ...roots, woco: { ...roots.woco, indexDocument: "index.html" } })), null);
  const pageRoots = pageLine().roots;
  const pageWithIndexFile = { ...good(), runtimes: { ...good().runtimes, eventPage: { ...pageLine(), roots: { ...pageRoots, woco: { ...pageRoots.woco, files: { "site.html": { ref: H("6"), contentType: "image/png" } } } } } } };
  assert.equal(parseSiteRuntimeRelease(pageWithIndexFile), null, "a page's own index document is never a shared file");
});

test("a v1 descriptor is refused: the server reads v2 only", () => {
  const v1 = { format: "woco.site-runtime.v1", version: 1, commit: "a".repeat(40), builtAt: "2026-11-02T15:00:00.000Z", dist: { files: 1, bytes: 1 }, roots: siteLine().roots };
  assert.equal(parseSiteRuntimeRelease(v1), null);
});

test("the owner is the frontend deploy key, lowercase", () => {
  assert.match(SITE_RUNTIME_RELEASE_OWNER, /^0x[0-9a-f]{40}$/);
});

test("format, version, commit and time are checked", () => {
  for (const bad of [
    { format: "woco.site-runtime.v1" },
    { version: 0 }, { version: 1.5 }, { version: "3" },
    { commit: "a".repeat(39) }, { commit: "A".repeat(40) },
    { builtAt: "yesterday" },
  ]) assert.equal(parseSiteRuntimeRelease({ ...good(), ...bad }), null, JSON.stringify(bad));
  for (const dist of [{ files: 0, bytes: 1 }, { files: 1 }]) {
    assert.equal(parseSiteRuntimeRelease({ ...good(), runtimes: { ...good().runtimes, site: { ...siteLine(), dist } } }), null, JSON.stringify(dist));
  }
});

test("every root and edge address is 64 lowercase hex, and the woco root is required", () => {
  const roots = siteLine().roots;
  for (const bad of [
    { woco: { ...roots.woco, root: H("1").slice(1) } },
    { woco: { ...roots.woco, root: "0x" + H("1").slice(2) } },
    { woco: { ...roots.woco, edges: { "assets/": H("G") } } },
    { etherna: { ...roots.etherna, root: H("Z") } },
    { woco: undefined },
  ]) assert.equal(parseSiteRuntimeRelease(withSiteRoots({ ...roots, ...bad })), null, JSON.stringify(bad));
});

test("shared files: plain names, data refs, never HTML, never the per-page documents", () => {
  const roots = siteLine().roots;
  const withFiles = (files: unknown) => parseSiteRuntimeRelease(withSiteRoots({ ...roots, woco: { ...roots.woco, files } }));
  assert.ok(withFiles({}), "no shared files is fine");
  for (const files of [
    { "logo.png": { ref: H("6"), contentType: "text/html; charset=utf-8" } },
    { "x.svg": { ref: H("6"), contentType: "application/xhtml+xml" } },
    { "vite.svg": { ref: H("6"), contentType: "image/svg+xml" } },
    { "feed.xml": { ref: H("6"), contentType: "application/xml" } },
    { "x.bin": { ref: H("6"), contentType: "application/octet-stream" } },
    { "multi-site.html": { ref: H("6"), contentType: "image/png" } },
    { "manifest.json": { ref: H("6"), contentType: "application/json" } },
    { "dir/logo.png": { ref: H("6"), contentType: "image/png" } },
    { "logo.png": { ref: "nope", contentType: "image/png" } },
    { "logo.png": { ref: H("6") } },
    undefined,
  ]) assert.equal(withFiles(files), null, JSON.stringify(files));
});

test("edges are real top-level directories, and only known stores are allowed", () => {
  const roots = siteLine().roots;
  for (const edges of [{}, { "/assets/": H("2") }, { "": H("2") }, { ["x".repeat(30) + "/"]: H("2") }, { "a b/": H("2") }, { "m": H("2") }, { "logo.png": H("2") }]) {
    assert.equal(parseSiteRuntimeRelease(withSiteRoots({ ...roots, woco: { ...roots.woco, edges } })), null, JSON.stringify(edges));
  }
  assert.equal(parseSiteRuntimeRelease(withSiteRoots({ ...roots, ipfs: roots.woco })), null);
  assert.equal(parseSiteRuntimeRelease(withSiteRoots({ ...roots, woco: { ...roots.woco, indexDocument: "../x.html" } })), null);
});

test("anything that is not an object is refused", () => {
  for (const v of [null, undefined, 1, "x", [], [good()]]) assert.equal(parseSiteRuntimeRelease(v), null);
});
