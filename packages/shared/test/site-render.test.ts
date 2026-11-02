/**
 * #1032 slice 2 — the site render moved from the server into shared code without
 * changing a byte. `fixtures/site-render-vectors.json` was generated from the
 * server's own functions BEFORE the move (an ordinary site, a bare Etherna-hosted
 * one, and one made of hostile organiser text). One deliberate change since: the
 * manifests' icon paths gained `icons/` (they 404'd); apps/web/test/site-pwa-icons
 * checks every icon named there ships in the runtime.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { renderSiteHtml, sitePwaManifest, deployHeadLines } from "../src/site/render.js";

interface Vector { name: string; template: string; site: any; gatewayUrl: string; config: unknown; html: string; manifest: string }
const vectors: Vector[] = JSON.parse(readFileSync(new URL("./fixtures/site-render-vectors.json", import.meta.url), "utf8"));

test("the vectors cover the cases that matter", () => {
  assert.equal(vectors.length, 3);
  assert.ok(Object.prototype.hasOwnProperty.call(vectors[2]!.site, "__proto__"), "the hostile site carries an own __proto__");
});

for (const v of vectors) {
  test(`renders exactly as the server did: ${v.name}`, () => {
    assert.equal(renderSiteHtml({ template: v.template, config: v.config, site: v.site, gatewayUrl: v.gatewayUrl }), v.html);
    assert.equal(JSON.stringify(sitePwaManifest(v.site)), v.manifest);
  });
}

test("hostile text stays data: the config script yields exactly the input, own __proto__ included", () => {
  const v = vectors[2]!;
  const html = renderSiteHtml({ template: v.template, config: v.config, site: v.site, gatewayUrl: v.gatewayUrl });
  const script = /<script>(window\.SITE_CONFIG=[\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script, "the config script is intact (no early </script>)");
  const sandbox: { window: { SITE_CONFIG?: unknown } } = { window: {} };
  vm.runInNewContext(script, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.window.SITE_CONFIG)), JSON.parse(JSON.stringify(v.config)));
  const site = (sandbox.window.SITE_CONFIG as { site: object }).site;
  assert.ok(Object.prototype.hasOwnProperty.call(site, "__proto__"), "__proto__ is an own property, not the prototype");
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  assert.equal((html.match(/<script>/g) ?? []).length, (v.template.match(/<script>/g) ?? []).length + 1, "no extra script element");
});

test("head tags escape every organiser value", () => {
  const lines = deployHeadLines(vectors[2]!.site, vectors[2]!.gatewayUrl);
  assert.doesNotMatch(lines, /<script|<img|<\/style/);
  for (const m of lines.matchAll(/content="([^"]*)"/g)) assert.doesNotMatch(m[1]!, /[<>]/);
});
