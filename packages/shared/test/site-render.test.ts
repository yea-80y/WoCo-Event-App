/**
 * #1032 slice 2 — the site render moved from the server into shared code without
 * changing a byte. `fixtures/site-render-vectors.json` was generated from the
 * server's own functions BEFORE the move (an ordinary site, a bare Etherna-hosted
 * one, and one made of hostile organiser text). Deliberate changes since: the
 * manifests' icon paths gained `icons/` (they 404'd; apps/web/test/site-pwa-icons
 * checks every icon named there ships in the runtime); #70 replaced the template's
 * `<title>` in each vector with the site's name, escaped exactly as its pinned
 * og:title, and added a fourth vector, the first one under a WoCo name, whose only
 * other difference is its canonical line.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { renderSiteHtml, sitePwaManifest, deployHeadLines } from "../src/site/render.js";

interface Vector { name: string; template: string; site: any; gatewayUrl: string; config: unknown; html: string; manifest: string }
const vectors: Vector[] = JSON.parse(readFileSync(new URL("./fixtures/site-render-vectors.json", import.meta.url), "utf8"));

test("the vectors cover the cases that matter", () => {
  assert.equal(vectors.length, 4);
  assert.ok(Object.prototype.hasOwnProperty.call(vectors[2]!.site, "__proto__"), "the hostile site carries an own __proto__");
  assert.equal(vectors[3]!.site.subEnsLabel, "acme-pub", "one site is published under a name");
});

for (const v of vectors) {
  test(`renders exactly as pinned: ${v.name}`, () => {
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

test("a site's title is its name, once, as og:title carries it (#70)", () => {
  const v = vectors[0]!;
  const render = (site: any, template = v.template) => renderSiteHtml({ template, config: v.config, site, gatewayUrl: v.gatewayUrl });
  const titleOf = (html: string) => [...html.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1]);
  const theme = (brandName: string) => ({ ...v.site, theme: { ...v.site.theme, brandName } });
  assert.deepEqual(titleOf(render(theme("  Acme  "))), ["Acme"]);
  assert.deepEqual(titleOf(render(theme("   "))), ["WoCo Site"]);
  // A template without a title gets one; one with attributes or in capitals is replaced, not doubled.
  assert.deepEqual(titleOf(render(v.site, v.template.replace(/<title>[^<]*<\/title>/, ""))), ["Acme Pub"]);
  for (const t of ['<title lang="en">Site</title>', "<title >Site</title>", "<TITLE>Site</TITLE>"]) {
    const html = render(v.site, v.template.replace(/<title>[^<]*<\/title>/, t));
    assert.deepEqual(titleOf(html), ["Acme Pub"], t);
    assert.equal(html.match(/<title\b/gi)?.length, 1, t);
  }
  // Hostile text, live: exactly the escaped title, and no extra script.
  const h = vectors[2]!;
  const html = renderSiteHtml({ template: h.template, config: h.config, site: h.site, gatewayUrl: h.gatewayUrl });
  const og = /<meta property="og:title" content="([^"]*)">/.exec(html)![1];
  assert.deepEqual(titleOf(html), [og]);
  assert.equal((html.match(/<script>/g) ?? []).length, (h.template.match(/<script>/g) ?? []).length + 1);
});

test("the canonical is the site's WoCo name, and only a valid name (#70)", () => {
  const v = vectors[0]!;
  const canonicals = (subEnsLabel: unknown) =>
    [...deployHeadLines({ ...v.site, subEnsLabel }, v.gatewayUrl).matchAll(/<link rel="canonical" href="([^"]*)">/g)].map((m) => m[1]);
  assert.deepEqual(canonicals("acme-pub"), ["https://acme-pub.woco.eth.limo/"]);
  for (const bad of [undefined, "", "ab", "Acme", "-acme", "acme-", "a--b", "acme.pub", "acme/x", 'a"><script>', "x".repeat(64)]) {
    assert.deepEqual(canonicals(bad), [], String(bad));
  }
  // Never a gateway URL: the canonical names the WoCo name's host, whatever gateway the site is built for.
  assert.doesNotMatch(deployHeadLines({ ...v.site, subEnsLabel: "acme-pub" }, v.gatewayUrl), /rel="canonical" href="[^"]*(gateway|woco-net)/);
  assert.doesNotMatch(deployHeadLines({ ...v.site, subEnsLabel: "acme-pub" }, v.gatewayUrl), /og:url/);
});

test("head tags escape every organiser value", () => {
  const lines = deployHeadLines(vectors[2]!.site, vectors[2]!.gatewayUrl);
  assert.doesNotMatch(lines, /<script|<img|<\/style/);
  for (const m of lines.matchAll(/content="([^"]*)"/g)) assert.doesNotMatch(m[1]!, /[<>]/);
});
