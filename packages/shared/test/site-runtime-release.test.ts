/**
 * #1032 — the site runtime release descriptor parses strictly: it names
 * addresses a site will link and the server will admit.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { parseSiteRuntimeRelease, SITE_RUNTIME_FORMAT, SITE_RUNTIME_RELEASE_OWNER } from "../src/site/runtime-release.js";

const H = (c: string) => c.repeat(64);
const good = () => ({
  format: SITE_RUNTIME_FORMAT,
  version: 3,
  commit: "a".repeat(40),
  builtAt: "2026-11-02T15:00:00.000Z",
  dist: { files: 251, bytes: 8_900_000 },
  roots: {
    woco: {
      root: H("1"), indexDocument: "multi-site.html", edges: { "assets/": H("2"), "icons/": H("3") },
      files: { "logo.png": { ref: H("6"), contentType: "image/png" }, "app.webmanifest.json": { ref: H("7"), contentType: "application/json" } },
    },
    etherna: { root: H("4"), indexDocument: "multi-site.html", edges: { "assets/": H("5") }, files: {} },
  },
});

test("a well-formed descriptor parses to the same values", () => {
  assert.deepEqual(parseSiteRuntimeRelease(good()), good());
  const { etherna: _e, ...wocoOnly } = good().roots;
  assert.deepEqual(parseSiteRuntimeRelease({ ...good(), roots: wocoOnly })?.roots, wocoOnly, "etherna is optional");
});

test("the owner is the frontend deploy key, lowercase", () => {
  assert.match(SITE_RUNTIME_RELEASE_OWNER, /^0x[0-9a-f]{40}$/);
});

test("format, version, commit and time are checked", () => {
  for (const bad of [
    { format: "woco.site-runtime.v2" },
    { version: 0 }, { version: 1.5 }, { version: "3" },
    { commit: "a".repeat(39) }, { commit: "A".repeat(40) },
    { builtAt: "yesterday" },
    { dist: { files: 0, bytes: 1 } }, { dist: { files: 1 } },
  ]) assert.equal(parseSiteRuntimeRelease({ ...good(), ...bad }), null, JSON.stringify(bad));
});

test("every root and edge address is 64 lowercase hex, and the woco root is required", () => {
  const roots = good().roots;
  for (const bad of [
    { woco: { ...roots.woco, root: H("1").slice(1) } },
    { woco: { ...roots.woco, root: "0x" + H("1").slice(2) } },
    { woco: { ...roots.woco, edges: { "assets/": H("G") } } },
    { etherna: { ...roots.etherna, root: H("Z") } },
    { woco: undefined },
  ]) assert.equal(parseSiteRuntimeRelease({ ...good(), roots: { ...roots, ...bad } }), null, JSON.stringify(bad));
});

test("shared files: plain names, data refs, never HTML, never the per-site documents", () => {
  const roots = good().roots;
  const withFiles = (files: unknown) => parseSiteRuntimeRelease({ ...good(), roots: { ...roots, woco: { ...roots.woco, files } } });
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
  const roots = good().roots;
  for (const edges of [{}, { "/assets/": H("2") }, { "": H("2") }, { ["x".repeat(30) + "/"]: H("2") }, { "a b/": H("2") }, { "m": H("2") }, { "logo.png": H("2") }]) {
    assert.equal(parseSiteRuntimeRelease({ ...good(), roots: { ...roots, woco: { ...roots.woco, edges } } }), null, JSON.stringify(edges));
  }
  assert.equal(parseSiteRuntimeRelease({ ...good(), roots: { ...roots, ipfs: roots.woco } }), null);
  assert.equal(parseSiteRuntimeRelease({ ...good(), roots: { ...roots, woco: { ...roots.woco, indexDocument: "../x.html" } } }), null);
});

test("anything that is not an object is refused", () => {
  for (const v of [null, undefined, 1, "x", [], [good()]]) assert.equal(parseSiteRuntimeRelease(v), null);
});
