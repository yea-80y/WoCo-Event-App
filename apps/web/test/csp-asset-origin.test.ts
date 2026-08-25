/**
 * The app's own JS and CSS are not served from the origin that serves its HTML.
 *
 * `scripts/upload-to-swarm-feed.cjs` injects `<base href="{gateway}/bzz/{hash}/">`
 * into index.html at pass 2, so every relative `./assets/…` URL resolves to the
 * gateway — whichever origin served the page. On gateway.woco-net.com that is
 * same-origin and `'self'` covers it. On woco.eth.limo it is cross-origin and
 * `'self'` does NOT, which took the eth.limo build down while the gateway looked
 * perfect.
 *
 * The failure is invisible from one of the two origins, so it cannot be caught by
 * checking the app loads. These tests pin the relationship instead.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ASSET_ORIGIN, APP_POLICY, VERIFY_POLICY } from "../vite-plugins/csp.js";

const uploadScript = readFileSync(
  new URL("../../../scripts/upload-to-swarm-feed.cjs", import.meta.url),
  "utf-8",
);

test("the CSP's asset origin is the one the upload script actually injects", () => {
  const injected = uploadScript.match(/<base href="(https:\/\/[^/"]+)\/bzz\//);
  assert.ok(injected, "could not find the injected <base href> in upload-to-swarm-feed.cjs");
  assert.equal(
    injected[1],
    ASSET_ORIGIN,
    "the upload script points assets at a different origin than the CSP allows — every " +
      "script and stylesheet would be blocked on any serving origin that is not that one",
  );
});

test("every directive that fetches our own bundle allows the asset origin", () => {
  for (const directive of ["base-uri", "script-src", "style-src"] as const) {
    assert.ok(
      APP_POLICY[directive]?.includes(ASSET_ORIGIN),
      `${directive} omits ${ASSET_ORIGIN} — on woco.eth.limo this blocks the app's own assets`,
    );
  }
  // Already present for other reasons (Swarm reads, event images), asserted so a
  // tidy-up cannot remove them without failing here.
  assert.ok(APP_POLICY["img-src"]?.includes(ASSET_ORIGIN));
  assert.ok(APP_POLICY["connect-src"]?.includes(ASSET_ORIGIN));
});

test("base-uri allows the asset origin, or the <base> tag itself is ignored", () => {
  // Distinct from the check above because the failure mode differs: a blocked
  // <base> does not block assets, it silently resolves them against the serving
  // origin instead, where they 404. That reads as "the build is broken", not as
  // a policy problem.
  assert.ok(APP_POLICY["base-uri"]?.includes(ASSET_ORIGIN));
});

test("verify.html is NOT widened — it gets no base href, so its assets are same-origin", () => {
  assert.ok(
    !uploadScript.includes("verify.html"),
    "the upload script now touches verify.html; re-check whether its policy needs the asset origin",
  );
  for (const directive of ["script-src", "style-src", "base-uri"] as const) {
    assert.ok(
      !VERIFY_POLICY[directive]?.includes(ASSET_ORIGIN),
      `${directive} was widened on the verify page without needing it`,
    );
  }
});
