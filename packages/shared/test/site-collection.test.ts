/**
 * #1032 slice 3: the manifest codec reproduces bee's own encoding of the live
 * release (fixtures/site-runtime-release-v1.json, read back from our bee), and a
 * site built on it links the release and adds only its own two files.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  encodeMantarayFork,
  encodeMantarayNode,
  mantarayNodeAddress,
  parseMantarayNode,
} from "../src/swarm/mantaray.js";
import { buildSiteCollection, sameSiteObjects, siteDeployConfig, SITE_HTML_MAX_BYTES } from "../src/site/collection.js";
import { renderSiteHtml, sitePwaManifest } from "../src/site/render.js";
import { bytesTreeRoot } from "../src/swarm/bytes-tree.js";
import type { SiteRuntimeRoot } from "../src/site/runtime-release.js";
import type { Site } from "../src/site/types.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/site-runtime-release-v1.json", import.meta.url), "utf8"));
const release: SiteRuntimeRoot = fx.release;
const rootNode = hexToBytes(fx.rootNode);
const urls = { apiUrl: "https://events-api.woco-net.com", gatewayUrl: "https://gateway.woco-net.com", wocoAppUrl: "https://woco.eth.limo" };
const site = {
  siteId: "site_collection_1",
  ownerAddress: "0x" + "ab".repeat(20),
  theme: { brandName: "Acme Pub", siteDescription: "Live music", palette: { accent: "#ff3366", bg: "#101010" } },
  pages: [],
} as unknown as Site;

test("parse + re-encode reproduces bee's release root byte for byte", () => {
  assert.equal(mantarayNodeAddress(rootNode), release.root);
  const node = parseMantarayNode(rootNode);
  assert.equal(node.entry, null);
  assert.deepEqual(node.forks.map((f) => f.prefix), ["/", "assets/", "icons/", "logo.png", "m", "vite.svg"]);
  for (const f of node.forks) {
    const again = encodeMantarayFork({ type: f.type, prefix: f.prefix, ref: f.ref, ...(f.metadata ? { metadata: f.metadata } : {}) });
    assert.equal(bytesToHex(again), bytesToHex(f.record), `fork ${f.prefix} re-encodes as bee wrote it (metadata padding included)`);
  }
  assert.equal(bytesToHex(encodeMantarayNode(null, node.forks.map((f) => f.record))), fx.rootNode);
});

test("the files node and leaves bee wrote are reproduced from their parts", () => {
  const files = parseMantarayNode(hexToBytes(fx.filesNode.data));
  const rebuilt = encodeMantarayNode(null, files.forks.map((f) => encodeMantarayFork({ type: f.type, prefix: f.prefix, ref: f.ref, metadata: f.metadata! })));
  assert.equal(bytesToHex(rebuilt), fx.filesNode.data);
  assert.equal(mantarayNodeAddress(rebuilt), fx.filesNode.address);
  for (const leaf of [fx.manifestLeaf, fx.htmlLeaf]) {
    const entry = parseMantarayNode(hexToBytes(leaf.data)).entry!;
    assert.equal(bytesToHex(encodeMantarayNode(entry, [])), leaf.data);
    assert.equal(mantarayNodeAddress(hexToBytes(leaf.data)), leaf.address);
  }
});

test("a site links the release's shared forks and adds only its own files", () => {
  const c = buildSiteCollection({ site, urls, template: fx.template, release, releaseRootNode: rootNode });
  assert.equal(c.objects.length, 6);
  assert.equal(c.objects.at(-1)!.address, c.root);
  for (const o of c.objects) assert.equal(bytesTreeRoot(o.data), o.address);

  const root = parseMantarayNode(c.rootNode);
  assert.deepEqual(root.forks.map((f) => f.prefix), ["/", "assets/", "icons/", "logo.png", "m"], "vite.svg is not offered");
  const shared = new Map(parseMantarayNode(rootNode).forks.map((f) => [f.prefix, bytesToHex(f.record)]));
  for (const f of root.forks.filter((f) => f.prefix !== "m")) assert.equal(bytesToHex(f.record), shared.get(f.prefix), `${f.prefix} copied whole`);

  const m = root.forks.find((f) => f.prefix === "m")!;
  assert.equal(m.ref, c.objects[4]!.address);
  const files = parseMantarayNode(c.objects[4]!.data).forks;
  assert.deepEqual(files.map((f) => [f.prefix, f.metadata]), [
    ["anifest.json", { "Content-Type": "application/json", Filename: "manifest.json" }],
    ["ulti-site.html", { "Content-Type": "text/html; charset=utf-8", Filename: "multi-site.html" }],
  ]);
  const html = new TextDecoder().decode(c.objects[0]!.data);
  assert.equal(html, renderSiteHtml({ template: fx.template, config: siteDeployConfig(site, urls), site, gatewayUrl: urls.gatewayUrl }));
  assert.equal(new TextDecoder().decode(c.objects[1]!.data), JSON.stringify(sitePwaManifest(site)));
  assert.equal(parseMantarayNode(c.objects[2]!.data).entry, c.objects[0]!.address);
  assert.equal(parseMantarayNode(c.objects[3]!.data).entry, c.objects[1]!.address);
});

test("the build is deterministic and any change in input changes the root", () => {
  const a = buildSiteCollection({ site, urls, template: fx.template, release, releaseRootNode: rootNode });
  const b = buildSiteCollection({ site, urls, template: fx.template, release, releaseRootNode: rootNode });
  assert.ok(sameSiteObjects(a, b.objects.map((o) => o.data)));
  const other = buildSiteCollection({ site: { ...site, theme: { ...site.theme, brandName: "Acme Bar" } } as Site, urls, template: fx.template, release, releaseRootNode: rootNode });
  assert.notEqual(other.root, a.root);
  assert.ok(!sameSiteObjects(a, other.objects.map((o) => o.data)));
  assert.ok(!sameSiteObjects(a, a.objects.slice(0, -1).map((o) => o.data)), "a missing object");
  assert.ok(!sameSiteObjects(a, [...a.objects.map((o) => o.data), new Uint8Array(1)]), "an extra object");
  const flipped = a.objects.map((o) => o.data.slice());
  flipped[0]![0] ^= 1;
  assert.ok(!sameSiteObjects(a, flipped), "one byte changed");
});

test("a release that does not match its descriptor is refused, never built around", () => {
  const build = (r: SiteRuntimeRoot, node = rootNode) => buildSiteCollection({ site, urls, template: fx.template, release: r, releaseRootNode: node });
  const tampered = rootNode.slice();
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => build(release, tampered), /does not match its address/);
  assert.throws(() => build({ ...release, edges: { ...release.edges, "assets/": "00".repeat(32) } }), /edge assets\//);
  assert.throws(() => build({ ...release, edges: { ...release.edges, "fonts/": release.edges["assets/"]! } }), /edge fonts\//);
  assert.throws(() => build({ ...release, files: { "logo.png": { ...release.files["logo.png"]!, contentType: "image/jpeg" } } }), /file logo\.png/);
  assert.throws(() => build({ ...release, files: { "vite.svg": { ref: "00".repeat(32), contentType: "image/png" } } }), /file vite\.svg/);
  assert.throws(() => build({ ...release, indexDocument: "index.html" }), /index document/);
});

test("a release whose shared directory is not a plain directory edge is refused", () => {
  // Re-encode the release root with assets/ marked as a value (a file) too, under a matching root.
  const forks = parseMantarayNode(rootNode).forks.map((f) =>
    f.prefix === "assets/" ? encodeMantarayFork({ type: f.type | 2, prefix: f.prefix, ref: f.ref }) : f.record,
  );
  const node = encodeMantarayNode(null, forks);
  const r = { ...release, root: mantarayNodeAddress(node) };
  assert.throws(() => buildSiteCollection({ site, urls, template: fx.template, release: r, releaseRootNode: node }), /edge assets\//);
});

test("metadata is written with sorted keys, whatever order it was given in", () => {
  const leaf = parseMantarayNode(hexToBytes(fx.filesNode.data)).forks.find((f) => f.prefix === "ulti-site.html")!;
  const reordered = encodeMantarayFork({ type: leaf.type, prefix: leaf.prefix, ref: leaf.ref, metadata: { Filename: "multi-site.html", "Content-Type": "text/html; charset=utf-8" } });
  assert.equal(bytesToHex(reordered), bytesToHex(leaf.record));
});

test("metadata padding follows bee: to 32 below it, none at exactly 32, to the next multiple above", () => {
  const meta = (json: string) => {
    const rec = encodeMantarayFork({ type: 18, prefix: "a", ref: "00".repeat(32), metadata: JSON.parse(json) });
    return rec.length - 64; // after the fixed fork part: length(2) + JSON + padding
  };
  assert.equal(meta('{"a":"b"}'), 32);
  // `{"a":"` + x's + `"}` is 8 + x's characters of JSON.
  assert.equal(meta(`{"a":"${"x".repeat(22)}"}`), 32, "2 + 30 = 32 exactly: no padding");
  assert.equal(meta(`{"a":"${"x".repeat(23)}"}`), 64);
  assert.equal(meta(`{"a":"${"x".repeat(54)}"}`), 96, "2 + 62 = 64: a full 32 of padding");
});

test("a node whose references are not 32 bytes is refused", () => {
  const n = hexToBytes(fx.manifestLeaf.data).slice();
  n[63] = 0;
  assert.throws(() => parseMantarayNode(n), /ref size/);
});

test("an oversize site is refused", () => {
  const big = { ...site, theme: { ...site.theme, siteDescription: "x".repeat(SITE_HTML_MAX_BYTES) } } as Site;
  assert.throws(() => buildSiteCollection({ site: big, urls, template: fx.template, release, releaseRootNode: rootNode }), /too large/);
});

test("the codec refuses what it does not understand", () => {
  const obfuscated = rootNode.slice();
  obfuscated[0] = 1;
  assert.throws(() => parseMantarayNode(obfuscated), /obfuscated/);
  assert.throws(() => parseMantarayNode(rootNode.slice(0, rootNode.length - 3)), /truncated|trailing/);
  assert.throws(() => encodeMantarayFork({ type: 4, prefix: "x".repeat(31), ref: "00".repeat(32) }), /splitting/);
  assert.throws(() => encodeMantarayFork({ type: 18, prefix: "a", ref: "00".repeat(32) }), /metadata flag/);
  const f = encodeMantarayFork({ type: 4, prefix: "a", ref: "00".repeat(32) });
  assert.throws(() => encodeMantarayNode(null, [f, encodeMantarayFork({ type: 4, prefix: "ab", ref: "11".repeat(32) })]), /two forks/);
});
