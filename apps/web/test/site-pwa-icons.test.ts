/**
 * A deployed site's manifest.json may only name files the runtime ships. Every
 * site published before 2026-11-02 pointed its icons at ./icon-*.png while the
 * runtime carries them under icons/, so "Add to home screen" got a 404.
 * public/ is copied whole into dist-multisite (vite.multisite.config.ts sets no
 * publicDir), so the source tree is the shipped tree.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sitePwaManifest, newSiteFromTemplate } from "@woco/shared";

const web = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));

/** Width x height from a PNG's IHDR. */
function pngSize(path: string): string {
  const b = readFileSync(path);
  assert.equal(b.subarray(1, 4).toString("latin1"), "PNG", `${path} is a PNG`);
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
}

test("every icon a site manifest names ships in the runtime, at the size it claims", () => {
  let n = 0;
  const site = newSiteFromTemplate({
    templateId: "clean-modern-v1",
    ownerAddress: "0x" + "1".repeat(40),
    siteId: "site_icons_test",
    idGen: () => `id${n++}`,
  });
  const manifest = sitePwaManifest(site) as { start_url: string; icons: { src: string; sizes: string; type: string }[] };
  assert.ok(manifest.icons.length > 0);
  for (const icon of manifest.icons) {
    assert.match(icon.src, /^\.\/[\w./-]+$/, "a relative path inside the collection");
    const file = web(`public/${icon.src.slice(2)}`);
    assert.ok(existsSync(file), `${icon.src} ships in the runtime`);
    assert.equal(icon.type, "image/png");
    assert.equal(pngSize(file), icon.sizes, `${icon.src} is ${icon.sizes}`);
  }
  assert.ok(existsSync(web(manifest.start_url.slice(2))), "start_url is the runtime's entry");
});
