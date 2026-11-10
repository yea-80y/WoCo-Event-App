/**
 * #1032 slice 3: a browser-built site is admitted only when the server's own
 * rebuild is byte-identical, and stored object by object at the addresses both
 * sides computed. Release v1 as bee encoded it: packages/shared/test/fixtures.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { hexToBytes } from "@noble/hashes/utils.js";

const fx = JSON.parse(readFileSync(new URL("../../../packages/shared/test/fixtures/site-runtime-release-v1.json", import.meta.url), "utf8"));
const rootNode = hexToBytes(fx.rootNode);
const urls = { apiUrl: "https://events-api.woco-net.com", gatewayUrl: "https://gateway.woco-net.com", wocoAppUrl: "https://woco.eth.limo" };
const site = {
  siteId: "site_admit_1",
  ownerAddress: "0x" + "ab".repeat(20),
  theme: { brandName: "Acme Pub", palette: { accent: "#ff3366", bg: "#101010" } },
  pages: [],
} as never;

let mod: typeof import("../src/lib/site/collection-publish.js");
let shared: typeof import("@woco/shared/site/collection");
let bytesTreeRoot: (d: Uint8Array) => string;

/** What the fake bee does with the next /bytes upload. */
let answer: "correct" | "wrong" | "fail" = "correct";
const uploads: { headers: IncomingHttpHeaders; size: number }[] = [];
const bee: Server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/bytes") return void res.writeHead(500).end();
  const parts: Buffer[] = [];
  req.on("data", (d: Buffer) => parts.push(d));
  req.on("end", () => {
    const body = new Uint8Array(Buffer.concat(parts));
    uploads.push({ headers: req.headers, size: body.length });
    if (answer === "fail") return void res.writeHead(402).end('{"message":"batch not usable"}');
    const reference = answer === "correct" ? bytesTreeRoot(body) : "ee".repeat(32);
    res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ reference }));
  });
});

before(async () => {
  await new Promise<void>((r) => bee.listen(0, "127.0.0.1", r));
  process.env.BEE_URL = `http://127.0.0.1:${(bee.address() as AddressInfo).port}`;
  mod = await import("../src/lib/site/collection-publish.js");
  shared = await import("@woco/shared/site/collection");
  ({ bytesTreeRoot } = await import("@woco/shared/swarm/bytes-tree"));
});
after(() => new Promise<void>((r) => bee.close(() => r())));

const kit = () => ({ version: 1, line: "site" as const, store: "woco" as const, release: fx.release, rootNode, template: fx.template });
const clientBuild = (s = site, u = urls) => shared.buildSiteCollection({ site: s, urls: u, template: fx.template, release: fx.release, releaseRootNode: rootNode });
const b64 = (c: { objects: { data: Uint8Array }[] }) => c.objects.map((o) => Buffer.from(o.data).toString("base64"));

test("the deploy body's collection is decoded within bounds", () => {
  const good = { runtimeVersion: 1, objects: b64(clientBuild()) };
  assert.equal(mod.decodeClientCollection(good)!.objects.length, 6);
  for (const bad of [
    null, "x", {}, { runtimeVersion: 0, objects: good.objects }, { runtimeVersion: 1.5, objects: good.objects },
    { runtimeVersion: 1, objects: [] }, { runtimeVersion: 1, objects: "abc" }, { runtimeVersion: 1, objects: [1] },
    { runtimeVersion: 1, objects: ["not base64!"] },
    { runtimeVersion: 1, objects: Array(mod.CLIENT_COLLECTION_MAX_OBJECTS + 1).fill("AA==") },
    { runtimeVersion: 1, objects: ["A".repeat(Math.ceil((mod.CLIENT_COLLECTION_MAX_BYTES + 4) / 3) * 4)] },
  ]) {
    assert.equal(mod.decodeClientCollection(bad), null, JSON.stringify(bad)?.slice(0, 60));
  }
});

test("an event page is only ever admitted against the event-page line's kit", () => {
  const received = { runtimeVersion: 1, objects: [] as Uint8Array[] };
  const config = { apiUrl: "https://events-api.woco-net.com", gatewayUrl: "https://gateway.etherna.io", contentGatewayUrl: "https://gateway.woco-net.com", eventId: "evt_line_00001", eventSigner: "0x" + "5e".repeat(20) };
  assert.throws(() => mod.admitClientEventPage({ kit: kit(), config, head: { title: "Gig" }, received }), /eventPage line/);
});

test("admission: identical rebuild admitted; any difference refused", () => {
  const received = mod.decodeClientCollection({ runtimeVersion: 1, objects: b64(clientBuild()) })!;
  const ok = mod.admitClientCollection({ kit: kit(), site, urls, received });
  assert.ok(ok.ok);
  assert.equal(ok.collection.root, clientBuild().root);

  // A client that rendered anything else: its own text, another URL, another release.
  const other = { ...(site as object), theme: { brandName: "</script><script>alert(1)</script>", palette: { accent: "#000", bg: "#fff" } } } as never;
  const forged = mod.decodeClientCollection({ runtimeVersion: 1, objects: b64(clientBuild(other)) })!;
  const r1 = mod.admitClientCollection({ kit: kit(), site, urls, received: forged });
  assert.deepEqual([r1.ok, !r1.ok && r1.code], [false, "COLLECTION_MISMATCH"]);
  const r2 = mod.admitClientCollection({ kit: kit(), site, urls: { ...urls, apiUrl: "https://evil.example" }, received });
  assert.equal(r2.ok, false, "server renders with its own URLs");
  const r3 = mod.admitClientCollection({ kit: kit(), site, urls, received: { ...received, runtimeVersion: 2 } });
  assert.deepEqual([r3.ok, !r3.ok && r3.code], [false, "RUNTIME_RELEASE_CHANGED"]);

  // Same root claimed, one HTML byte relabelled; objects swapped; one missing.
  const tampered = received.objects.map((o) => o.slice());
  tampered[0]![10] ^= 1;
  assert.equal(mod.admitClientCollection({ kit: kit(), site, urls, received: { ...received, objects: tampered } }).ok, false);
  const swapped = [received.objects[1]!, received.objects[0]!, ...received.objects.slice(2)];
  assert.equal(mod.admitClientCollection({ kit: kit(), site, urls, received: { ...received, objects: swapped } }).ok, false);
  assert.equal(mod.admitClientCollection({ kit: kit(), site, urls, received: { ...received, objects: received.objects.slice(1) } }).ok, false);
});

/** The release v1 nodes on the way to multi-site.html, by address. */
const NODES = new Map<string, Uint8Array>([
  [fx.release.root, rootNode],
  [fx.filesNode.address, hexToBytes(fx.filesNode.data)],
  [fx.htmlLeaf.address, hexToBytes(fx.htmlLeaf.data)],
]);
const templateBytes = new TextEncoder().encode(fx.template);
/** Release v1's site runtime as the site line of a v2 descriptor (the page line is not read here). */
const siteRelease = () =>
  ({ version: 1, runtimes: { site: { dist: { files: 1, bytes: 1 }, roots: { woco: fx.release } }, eventPage: { dist: { files: 1, bytes: 1 }, roots: { woco: { ...fx.release, indexDocument: "site.html" } } } } }) as never;

test("a kit whose root node does not hash to the descriptor's root is refused, and not cached", async () => {
  let rootReads = 0;
  let root = rootNode.slice();
  root[root.length - 1] ^= 1;
  const asked: string[] = [];
  const kits = mod.createSiteRuntimeKits({
    node: async (_s, a) => {
      if (a === fx.release.root) { rootReads++; return root; }
      return NODES.get(a)!;
    },
    template: async (wocoRoot, index) => { asked.push(`${wocoRoot}/${index}`); return templateBytes; },
  });
  const release = siteRelease();
  await assert.rejects(kits.kit(release, "site", "woco"), /does not match/);
  root = rootNode;
  const k = await kits.kit(release, "site", "woco");
  assert.deepEqual([k.version, k.line, k.template], [1, "site", fx.template]);
  assert.equal(asked.at(-1), `${fx.release.root}/multi-site.html`, "the site line's index document");
  await kits.kit(release, "site", "woco");
  assert.equal(rootReads, 2, "a failed load is retried, a good one is cached");
  await assert.rejects(kits.kit(release, "site", "etherna"), /no site etherna root/);
});

test("an event-page kit reads its own line's root and index document (site.html)", async () => {
  const { encodeMantarayNode, encodeMantarayFork, mantarayNodeAddress } = await import("@woco/shared/swarm/mantaray");
  const { bytesTreeRoot } = await import("@woco/shared/swarm/bytes-tree");
  const pageTemplate = new TextEncoder().encode("<!doctype html><html><head><title>Event</title></head><body></body></html>");
  const leaf = encodeMantarayNode(bytesTreeRoot(pageTemplate), []);
  const slash = encodeMantarayNode(null, []);
  const root = encodeMantarayNode(null, [
    encodeMantarayFork({ type: 18, prefix: "/", ref: mantarayNodeAddress(slash), metadata: { "website-error-document": "site.html", "website-index-document": "site.html" } }),
    encodeMantarayFork({ type: 18, prefix: "site.html", ref: mantarayNodeAddress(leaf), metadata: { "Content-Type": "text/html; charset=utf-8", Filename: "site.html" } }),
  ]);
  const pageRoot = { root: mantarayNodeAddress(root), edges: {}, files: {}, indexDocument: "site.html" };
  const nodes = new Map([[pageRoot.root, root], [mantarayNodeAddress(leaf), leaf]]);
  const asked: string[] = [];
  const kits = mod.createSiteRuntimeKits({
    node: async (_s, a) => nodes.get(a) ?? new Uint8Array(0),
    template: async (wocoRoot, index) => { asked.push(`${wocoRoot}/${index}`); return pageTemplate; },
  });
  const release = { version: 2, runtimes: { site: { dist: { files: 1, bytes: 1 }, roots: { woco: fx.release } }, eventPage: { dist: { files: 1, bytes: 1 }, roots: { woco: pageRoot } } } } as never;
  const k = await kits.kit(release, "eventPage", "woco");
  assert.deepEqual([k.line, k.release.root, k.template], ["eventPage", pageRoot.root, new TextDecoder().decode(pageTemplate)]);
  assert.deepEqual(asked, [`${pageRoot.root}/site.html`]);
  // The two lines never share a cached kit.
  assert.equal((await kits.kit(release, "site", "woco").catch(() => null))?.line ?? "site", "site");
});

test("the template must be the one the signed root names, read through hash-checked nodes", async () => {
  const release = siteRelease();
  const kitWith = (template: Uint8Array, nodes = NODES) =>
    mod.createSiteRuntimeKits({ node: async (_s, a) => nodes.get(a) ?? new Uint8Array(0), template: async () => template }).kit(release, "site", "woco");
  const other = new TextEncoder().encode(fx.template.replace("<title>Site</title>", "<title>Other</title>"));
  await assert.rejects(kitWith(other), /template does not match its root/);
  const forged = new Map(NODES);
  const leaf = hexToBytes(fx.htmlLeaf.data).slice();
  leaf[70] ^= 1; // a different entry, under the address the parent names
  forged.set(fx.htmlLeaf.address, leaf);
  await assert.rejects(kitWith(templateBytes, forged), /does not match its address/);
});

test("objects are stored with /bytes at redundancy 0 on the deploy's batch, root last, each at its computed address", async () => {
  const c = clientBuild();
  uploads.length = 0;
  answer = "correct";
  const store = () => mod.deployStore({ target: "wocoBee", batchId: "aa".repeat(32) });
  const { bytes, rootLanded } = await mod.uploadSiteObjects(store(), c);
  assert.equal(bytes, c.objects.reduce((n, o) => n + o.data.length, 0));
  assert.equal(rootLanded, "woco");
  assert.deepEqual(uploads.map((u) => u.size), c.objects.map((o) => o.data.length), "in order, root last");
  for (const u of uploads) {
    assert.equal(u.headers["swarm-redundancy-level"], "0");
    assert.equal(u.headers["swarm-postage-batch-id"], "aa".repeat(32));
    assert.equal(u.headers["swarm-deferred-upload"], "false");
  }
  answer = "wrong";
  await assert.rejects(mod.uploadSiteObjects(store(), c), /expected/);
  answer = "fail";
  await assert.rejects(mod.uploadSiteObjects(store(), c), /402/);
  answer = "correct";
});
