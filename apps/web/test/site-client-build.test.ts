/**
 * #1032 slice 3, the browser half: the site is built from the server's kit on the
 * store the deploy will land on, rendered with the owner the server will stamp,
 * and a refusal or a foreign root never ends in a signed pointer.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildClientSiteCollection } from "../src/lib/api/site-collection.js";
import { rebuildForNewRuntime, storedSomethingElse } from "../src/lib/api/site-deploy-verdict.js";
import { buildSiteCollection, siteRenderUrls } from "@woco/shared/site/collection";

const fx = JSON.parse(readFileSync(new URL("../../../packages/shared/test/fixtures/site-runtime-release-v1.json", import.meta.url), "utf8"));
const kit = { version: 1, store: "woco", release: fx.release, rootNode: Buffer.from(fx.rootNode, "hex").toString("base64"), template: fx.template };
const PARENT = "0xAbCdEf" + "12".repeat(17);
const site = { siteId: "site_client_1", ownerAddress: "", theme: { brandName: "Acme", palette: { accent: "#f36", bg: "#111" } }, pages: [] } as never;
const input = { site, parentAddress: PARENT, apiUrl: "https://events-api.woco-net.com/", gatewayUrl: "https://gateway.woco-net.com", wocoAppUrl: "https://woco.eth.limo/x" };

const realFetch = globalThis.fetch;
const asked: string[] = [];
const cacheModes: Array<RequestCache | undefined> = [];
function serve(answer: (url: string) => unknown) {
  globalThis.fetch = (async (u: RequestInfo | URL, init?: RequestInit) => {
    asked.push(String(u));
    cacheModes.push(init?.cache);
    const body = answer(String(u));
    return new Response(JSON.stringify(body), { status: (body as { ok?: boolean }).ok ? 200 : 503, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}
test.afterEach(() => { globalThis.fetch = realFetch; asked.length = 0; cacheModes.length = 0; });

async function builtOk(i = input) {
  const r = await buildClientSiteCollection(i);
  assert.ok(r.ok, JSON.stringify(r));
  return r.built;
}

test("builds on the kit of the store the gateway lands on, with the owner the server stamps", async () => {
  serve(() => ({ ok: true, data: kit }));
  const built = await builtOk();
  assert.equal(asked[0], "https://events-api.woco-net.com/api/sites/runtime/kit/woco");
  assert.equal(cacheModes[0], "no-store", "never a cached kit: the rebuild after a new release must see it");
  assert.equal((built.site as { ownerAddress: string }).ownerAddress, PARENT.toLowerCase());
  // What the server rebuilds from the same request: `{ ...body.site, ownerAddress }` and the URL origins.
  const serverSite = { ...JSON.parse(JSON.stringify(built.site)), ownerAddress: PARENT.toLowerCase() };
  const server = buildSiteCollection({ site: serverSite, urls: siteRenderUrls(input), template: fx.template, release: fx.release, releaseRootNode: Buffer.from(fx.rootNode, "hex") });
  assert.equal(built.root, server.root);
  assert.deepEqual(built.body.objects, server.objects.map((o) => Buffer.from(o.data).toString("base64")));
  assert.equal(built.body.runtimeVersion, 1);
});

test("an Etherna deploy asks for the Etherna kit", async () => {
  serve(() => ({ ok: false, error: "x" }));
  assert.equal((await buildClientSiteCollection({ ...input, gatewayUrl: "https://gateway.etherna.io" })).ok, false);
  assert.match(asked[0]!, /\/kit\/etherna$/);
});

test("the server's reason is passed on; the wrong store's kit or one that does not hash is refused", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    serve(() => ({ ok: false, error: "The site runtime is unavailable right now", code: "RUNTIME_RELEASE_UNAVAILABLE" }));
    assert.deepEqual(await buildClientSiteCollection(input), { ok: false, error: "The site runtime is unavailable right now", code: "RUNTIME_RELEASE_UNAVAILABLE" });
    globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    assert.match((await buildClientSiteCollection(input) as { error: string }).error, /check your connection/);
    serve(() => ({ ok: true, data: { ...kit, store: "etherna" } }));
    assert.equal((await buildClientSiteCollection(input)).ok, false);
    const bad = Buffer.from(fx.rootNode, "hex");
    bad[bad.length - 1] ^= 1;
    serve(() => ({ ok: true, data: { ...kit, rootNode: bad.toString("base64") } }));
    assert.equal((await buildClientSiteCollection(input)).ok, false);
  } finally {
    console.warn = warn;
  }
});

test("only a newer runtime release earns a rebuild; every other refusal stands (no server build since slice 4)", () => {
  assert.equal(rebuildForNewRuntime({ ok: false, code: "RUNTIME_RELEASE_CHANGED" }), true);
  for (const code of ["COLLECTION_MISMATCH", "RUNTIME_RELEASE_UNAVAILABLE", "CLIENT_BUILD_REQUIRED", "BATCH_PURCHASE_REQUIRED", undefined]) {
    assert.equal(rebuildForNewRuntime({ ok: false, code }), false, String(code));
  }
  assert.equal(rebuildForNewRuntime({ ok: true }), false);
});

test("a client build stored at another root is caught before any pointer is signed", () => {
  const root = "ab".repeat(32);
  assert.equal(storedSomethingElse({ ok: true, data: { builtBy: "client", contentHash: root } }, root), false);
  assert.equal(storedSomethingElse({ ok: true, data: { builtBy: "client", contentHash: "cd".repeat(32) } }, root), true);
  assert.equal(storedSomethingElse({ ok: true, data: { builtBy: "client", contentHash: root } }, undefined), true);
  assert.equal(storedSomethingElse({ ok: true, data: { builtBy: "server", contentHash: "cd".repeat(32) } }, root), false);
});
