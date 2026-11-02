/**
 * #1032 slice 5: a single-event page built on the live release v2 `eventPage`
 * line (fixtures/site-runtime-release-v2-event-page.json, read back from our bee)
 * links the release and adds only its own two files, laid out as bee lays them.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { parseMantarayNode, encodeMantarayFork } from "../src/swarm/mantaray.js";
import { bytesTreeRoot } from "../src/swarm/bytes-tree.js";
import { buildEventPageCollection, sameSiteObjects } from "../src/site/collection.js";
import { eventPageDeployConfig, eventPagePwaManifest, renderEventPageHtml } from "../src/site/event-page.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/site-runtime-release-v2-event-page.json", import.meta.url), "utf8"));
const rootNode = hexToBytes(fx.rootNode);
const config = eventPageDeployConfig({
  apiUrl: "https://events-api.woco-net.com",
  gatewayUrl: "https://gateway.etherna.io",
  contentGatewayUrl: "https://gateway.woco-net.com",
  eventId: "evt_collection_01",
  eventSigner: "0x" + "cd".repeat(20),
});
const head = { title: "Friday Gig", imageHash: "ab".repeat(32) };
const build = (h: typeof head | null = head) => buildEventPageCollection({ config, head: h, template: fx.template, release: fx.release, releaseRootNode: rootNode });

test("a page links the release's shared forks and adds manifest.json + site.html as bee would", () => {
  const c = build();
  assert.equal(c.objects.length, 5);
  assert.equal(c.objects.at(-1)!.address, c.root);
  for (const o of c.objects) assert.equal(bytesTreeRoot(o.data), o.address);

  const forks = parseMantarayNode(c.rootNode).forks;
  assert.deepEqual(forks.map((f) => f.prefix), ["/", "assets/", "icons/", "logo.png", "manifest.json", "site.html"], "the app manifest and vite.svg are not linked");
  const release = new Map(parseMantarayNode(rootNode).forks.map((f) => [f.prefix, bytesToHex(f.record)]));
  for (const f of forks.filter((f) => !["manifest.json", "site.html"].includes(f.prefix))) {
    assert.equal(bytesToHex(f.record), release.get(f.prefix), `${f.prefix} copied whole`);
  }
  // The page's own records are encoded exactly as the release's were (type, padding, key order).
  for (const name of ["manifest.json", "site.html"]) {
    const ours = forks.find((f) => f.prefix === name)!;
    const theirs = parseMantarayNode(rootNode).forks.find((f) => f.prefix === name)!;
    assert.deepEqual([ours.type, ours.metadata], [theirs.type, theirs.metadata]);
    assert.equal(bytesToHex(encodeMantarayFork({ type: theirs.type, prefix: name, ref: ours.ref, metadata: theirs.metadata! })), bytesToHex(ours.record));
  }

  const html = new TextDecoder().decode(c.objects[0]!.data);
  assert.equal(html, renderEventPageHtml({ template: fx.template, config, head }));
  assert.match(html, /<link rel="manifest" href="\.\/manifest\.json">/);
  assert.equal(new TextDecoder().decode(c.objects[1]!.data), JSON.stringify(eventPagePwaManifest(head)));
  assert.equal(parseMantarayNode(c.objects[2]!.data).entry, c.objects[0]!.address);
  assert.equal(parseMantarayNode(c.objects[3]!.data).entry, c.objects[1]!.address);
});

test("the per-page manifest names the event and points at runtime icons", () => {
  const m = eventPagePwaManifest(head) as { name: string; start_url: string; icons: { src: string }[] };
  assert.deepEqual([m.name, m.start_url], ["Friday Gig", "./site.html"]);
  assert.deepEqual(m.icons.map((i) => i.src), ["./icons/icon-192.png", "./icons/icon-512.png"]);
  assert.equal((eventPagePwaManifest(null) as { name: string }).name, "Event");
});

test("the build is deterministic and any input changes the root", () => {
  const a = build();
  assert.ok(sameSiteObjects(a, build().objects.map((o) => o.data)));
  assert.notEqual(build({ title: "Saturday Gig", imageHash: head.imageHash }).root, a.root);
  assert.notEqual(build(null).root, a.root);
  assert.notEqual(buildEventPageCollection({ config: { ...config, eventSigner: "0x" + "ef".repeat(20) }, head, template: fx.template, release: fx.release, releaseRootNode: rootNode }).root, a.root);
});

test("a release file that would collide with the page's own manifest.json is refused, by name", async () => {
  const { encodeMantarayNode, mantarayNodeAddress } = await import("../src/swarm/mantaray.js");
  const leaf = encodeMantarayNode("11".repeat(32), []);
  const forks = parseMantarayNode(rootNode).forks.filter((f) => ["/", "assets/"].includes(f.prefix)).map((f) => f.record);
  forks.push(encodeMantarayFork({ type: 18, prefix: "mx.png", ref: mantarayNodeAddress(leaf), metadata: { "Content-Type": "image/png", Filename: "mx.png" } }));
  const node = encodeMantarayNode(null, forks);
  const release = { root: mantarayNodeAddress(node), edges: { "assets/": fx.release.edges["assets/"] }, files: { "mx.png": { ref: "11".repeat(32), contentType: "image/png" } }, indexDocument: "site.html" };
  assert.throws(
    () => buildEventPageCollection({ config, head, template: fx.template, release, releaseRootNode: node }),
    /collides with the page's own files/,
  );
});

test("a website release is not an event-page release", async () => {
  const site = JSON.parse(readFileSync(new URL("./fixtures/site-runtime-release-v1.json", import.meta.url), "utf8"));
  assert.throws(
    () => buildEventPageCollection({ config, head, template: site.template, release: site.release, releaseRootNode: hexToBytes(site.rootNode) }),
    /index document/,
  );
});
