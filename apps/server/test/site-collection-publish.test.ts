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

const kit = () => ({ version: 1, store: "woco" as const, release: fx.release, rootNode, template: fx.template });
const clientBuild = (s = site, u = urls) => shared.buildSiteCollection({ site: s, urls: u, template: fx.template, release: fx.release, releaseRootNode: rootNode });
const b64 = (c: { objects: { data: Uint8Array }[] }) => c.objects.map((o) => Buffer.from(o.data).toString("base64"));

test("the switch: unset is off, 'all' is everyone, else a list of accounts", () => {
  const a = "0x" + "12".repeat(20);
  assert.equal(mod.clientPublishAllowed(a, undefined), false);
  assert.equal(mod.clientPublishAllowed(a, ""), false);
  assert.equal(mod.clientPublishAllowed(a, "all"), true);
  assert.equal(mod.clientPublishAllowed(a, ` 0x${"34".repeat(20)} , ${a.toUpperCase().replace("0X", "0x")} `), true);
  assert.equal(mod.clientPublishAllowed(a, `0x${"34".repeat(20)}`), false);
});

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

test("a kit whose root node does not hash to the descriptor's root is refused, and not cached", async () => {
  let calls = 0;
  let node = rootNode.slice();
  node[node.length - 1] ^= 1;
  const kits = mod.createSiteRuntimeKits({
    rootNode: async () => { calls++; return node; },
    template: async () => fx.template,
  });
  const release = { version: 1, roots: { woco: fx.release } } as never;
  await assert.rejects(kits.kit(release, "woco"), /does not match/);
  node = rootNode;
  const k = await kits.kit(release, "woco");
  assert.equal(k.version, 1);
  await kits.kit(release, "woco");
  assert.equal(calls, 2, "a failed load is retried, a good one is cached");
  await assert.rejects(kits.kit(release, "etherna"), /no etherna root/);
});

test("objects are stored with /bytes at redundancy 0 on the deploy's batch, root last, each at its computed address", async () => {
  const c = clientBuild();
  uploads.length = 0;
  answer = "correct";
  const bytes = await mod.uploadSiteObjects("wocoBee", "aa".repeat(32), c);
  assert.equal(bytes, c.objects.reduce((n, o) => n + o.data.length, 0));
  assert.deepEqual(uploads.map((u) => u.size), c.objects.map((o) => o.data.length), "in order, root last");
  for (const u of uploads) {
    assert.equal(u.headers["swarm-redundancy-level"], "0");
    assert.equal(u.headers["swarm-postage-batch-id"], "aa".repeat(32));
    assert.equal(u.headers["swarm-deferred-upload"], "false");
  }
  answer = "wrong";
  await assert.rejects(mod.uploadSiteObjects("wocoBee", "aa".repeat(32), c), /expected/);
  answer = "fail";
  await assert.rejects(mod.uploadSiteObjects("wocoBee", "aa".repeat(32), c), /402/);
  answer = "correct";
});
