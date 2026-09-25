/**
 * Every content-feed read and write names where its feed is stamped (#651).
 *
 * The type system makes the route REQUIRED, so a call site cannot omit it. These
 * tests pin what the compiler cannot: which route each family uses, that a rail
 * reads and writes through ONE family (a feed read from one store and written to
 * another resolves its previous version as current, and the rewrite erases the
 * newer one), and that no optional gateway creeps back into the API.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import {
  ETHERNA_GATEWAY_URL,
  ETHERNA_ROUTE,
  FEED_ROUTES,
  WOCO_GATEWAY_URL,
  WOCO_ROUTE,
  feedRouteFor,
} from "../src/lib/swarm/gateways.js";
import { diagnoseManifest, readUserManifestResult } from "../src/lib/manifest/inventory.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
/** Comments stripped: several files name the wrong call in order to warn about it. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

test("each family is stamped where the table says - a move is a deliberate diff here", () => {
  const onEtherna = Object.entries(FEED_ROUTES).filter(([, r]) => r.target === "etherna").map(([k]) => k).sort();
  // Profiles have been Etherna since #617; event reads ask Etherna because new
  // events are stamped there. Everything else has not moved yet.
  assert.deepEqual(onEtherna, ["event", "profile"]);
  for (const [family, route] of Object.entries(FEED_ROUTES)) {
    const store = route.target === "etherna" ? ETHERNA_ROUTE : WOCO_ROUTE;
    assert.equal(route.gatewayUrl, store.gatewayUrl, `${family}: gateway disagrees with its target`);
    assert.equal(route.family, family, `${family}: route names another family`);
    assert.ok(Object.isFrozen(route), `${family}: not frozen`);
  }
});

test("every family has its OWN route, so a call using another family's is detectable", () => {
  const routes = Object.values(FEED_ROUTES);
  assert.equal(new Set(routes).size, routes.length, "two families share one route object");
});

test("the two routes are frozen and name the canonical gateways", () => {
  assert.equal(ETHERNA_ROUTE.gatewayUrl, ETHERNA_GATEWAY_URL);
  assert.equal(WOCO_ROUTE.gatewayUrl, WOCO_GATEWAY_URL);
  assert.ok(Object.isFrozen(ETHERNA_ROUTE) && Object.isFrozen(WOCO_ROUTE));
});

test("a feed's recorded gateway maps to its route by the server's own rule", () => {
  // Mirrors `isEthernaGateway` (apps/server/src/lib/etherna/batch-router.ts):
  // the host must END WITH Etherna's; anything else is the WoCo default.
  assert.equal(feedRouteFor(ETHERNA_GATEWAY_URL), ETHERNA_ROUTE);
  assert.equal(feedRouteFor(`${ETHERNA_GATEWAY_URL}/`), ETHERNA_ROUTE);
  assert.equal(feedRouteFor("https://eu.gateway.etherna.io"), ETHERNA_ROUTE);
  assert.equal(feedRouteFor(WOCO_GATEWAY_URL), WOCO_ROUTE);
  assert.equal(feedRouteFor(undefined), WOCO_ROUTE);
  assert.equal(feedRouteFor(""), WOCO_ROUTE);
  assert.equal(feedRouteFor("not a url"), WOCO_ROUTE);
  // Organiser-written: a look-alike host must not select Etherna.
  assert.equal(feedRouteFor("https://gateway.etherna.io.example.com"), WOCO_ROUTE);
});

// ---------------------------------------------------------------------------
// One family per rail
// ---------------------------------------------------------------------------

const RAILS: Record<string, string[]> = {
  "lib/api/profiles.ts": ["profile"],
  "lib/attendee/events/EventDetail.svelte": ["event"],
  "lib/manifest/inventory.ts": ["manifest"],
  "lib/social/social.ts": ["social"],
  "lib/campaign/records.ts": ["campaignIssuer", "referral"],
  "lib/auth/recovery-portability.ts": ["recoveryPortability"],
  "lib/swarm/recovery-feed.ts": ["recoveryEnvelope"],
  "lib/swarm/guardian-index-feed.ts": ["guardianIndex"],
  "lib/credits/credits.ts": ["credits"],
  "lib/cert/issue.ts": ["cert"],
};

test("each rail reads and writes through its own family only", () => {
  for (const [file, families] of Object.entries(RAILS)) {
    const used = [...new Set([...code(read(file)).matchAll(/FEED_ROUTES\.(\w+)/g)].map((m) => m[1]))].sort();
    assert.deepEqual(used, [...families].sort(), file);
  }
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(ts|svelte)$/.test(name) ? [p] : [];
  });
}

test("no rail picks a raw route or reaches the table indirectly", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file);
    if (rel === "lib/swarm/gateways.ts") continue;
    const src = code(readFileSync(file, "utf8"));
    // Raw constants, bracket access and an aliased import would all escape the
    // per-family check above.
    if (/\b(?:ETHERNA_ROUTE|WOCO_ROUTE)\b/.test(src)) offenders.push(`${rel}: raw route`);
    if (/FEED_ROUTES\s*\[/.test(src)) offenders.push(`${rel}: FEED_ROUTES[...]`);
    if (/FEED_ROUTES\s+as\s+\w/.test(src)) offenders.push(`${rel}: aliased FEED_ROUTES`);
  }
  assert.deepEqual(offenders, []);
});

test("a shared subject index takes its route from the family that owns it, never a fixed one", () => {
  const index = code(read("lib/social/subject-index.ts"));
  assert.doesNotMatch(index, /FEED_ROUTES\./);
  assert.equal([...index.matchAll(/route:\s*kind\.route\b/g)].length, 2, "the read and the write");
  // The referral index is read back in records.ts through the referral family.
  assert.match(code(read("lib/campaign/records.ts")), /const REFERRAL_INDEX = \{[\s\S]*?route: FEED_ROUTES\.referral,[\s\S]*?\} as const;/);
});

// ---------------------------------------------------------------------------
// The API cannot go back to an optional gateway
// ---------------------------------------------------------------------------

test("the content-feed reads and writes take no optional gateway, and the route stays required", () => {
  for (const file of ["lib/swarm/content-feed.ts", "lib/swarm/verified-write.ts"]) {
    const src = code(read(file));
    assert.doesNotMatch(src, /gatewayUrl\?\s*:/, file);
    assert.doesNotMatch(src, /\broute\?\s*:/, `${file}: an optional route is the omission this change removed`);
  }
});

/** The argument text of every `name(` call, brackets balanced - nested calls included. */
function callArgs(src: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b${name}\\(`, "g");
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    out.push(src.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

test("the argument scanner sees past nested calls", () => {
  assert.deepEqual(callArgs("probeSoc(a, f(b, 0), { gatewayUrl: x })", "probeSoc"), ["a, f(b, 0), { gatewayUrl: x }"]);
});

test("every direct probe in the app names a gateway", () => {
  const offenders: string[] = [];
  let seen = 0;
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file);
    if (rel === "lib/swarm/probe-soc.ts") continue; // the primitive itself
    for (const args of callArgs(code(readFileSync(file, "utf8")), "probeSoc")) {
      seen++;
      // Taken from a route, not merely present: `gatewayUrl: undefined` compiles.
      if (!/gatewayUrl:\s*(?:\w+\.)*route\.gatewayUrl\b|gatewayUrl:\s*FEED_ROUTES\.\w+\.gatewayUrl\b/.test(args)) {
        offenders.push(`${rel}: probeSoc(${args.replace(/\s+/g, " ")})`);
      }
    }
  }
  assert.ok(seen >= 6, `only ${seen} probeSoc calls found - the scan is not seeing them`);
  assert.deepEqual(offenders, []);
});

// ---------------------------------------------------------------------------
// The manifest's readers hand over the manifest route when they run
// ---------------------------------------------------------------------------

test("the manifest's head read and its repair walk both carry the manifest route", async () => {
  const signer = { privKey: `0x${"11".repeat(32)}`, address: `0x${"cc".repeat(20)}` };
  const parentAddress = `0x${"aa".repeat(20)}`;
  const seen: unknown[] = [];

  await readUserManifestResult({
    signer,
    parentAddress,
    readFeed: async (_owner, _topic, opts) => { seen.push(opts.route); return { status: "absent" }; },
  });
  await diagnoseManifest({
    signer,
    parentAddress,
    // A frozen head at version 3 makes the repair walk read versions below it.
    readManifest: async () => ({ status: "unavailable", reason: "frozen", unusableAt: 3 }),
    readAt: async (_owner, _topic, _v, opts) => { seen.push(opts.route); return { status: "absent" }; },
  });

  assert.ok(seen.length >= 2, `expected the head read and at least one walk read, saw ${seen.length}`);
  for (const route of seen) assert.equal(route, FEED_ROUTES.manifest);
});

test("a route can only be minted in gateways.ts", () => {
  // Branded (a type-only unique symbol), so a made-up `{ gatewayUrl }` does not
  // compile. The one escape is a cast, and only the minting module may use it.
  assert.match(read("lib/swarm/gateways.ts"), /readonly \[feedRouteBrand\]: true;/);
  const casts: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file);
    if (rel !== "lib/swarm/gateways.ts" && /\bas\s+FeedRoute\b/.test(code(readFileSync(file, "utf8")))) casts.push(rel);
  }
  assert.deepEqual(casts, []);
});

test("events, sites and shops stamp through the recorded-gateway mapping, and label the manifest by it", () => {
  assert.match(code(read("lib/api/events.ts")), /route:\s*feedRouteFor\(feed\.gatewayUrl\)/);
  assert.match(code(read("lib/api/sites.ts")), /route:\s*feedRouteFor\(gatewayUrl\)/);
  const sites = code(read("lib/api/sites.ts"));
  const publish = sites.slice(sites.indexOf("export async function publishSite("), sites.indexOf(") {", sites.indexOf("export async function publishSite(")));
  assert.match(publish, /\bgatewayUrl:\s*string\b/, "publishSite's gateway is required");
  for (const file of ["lib/creator/events/PublishButton.svelte", "lib/creator/builder/MultiSiteBuilder.svelte", "lib/creator/shops/ShopEditor.svelte"]) {
    const src = code(read(file));
    assert.match(src, /target:\s*feedRouteFor\([^)]*\)\.target/, file);
    assert.doesNotMatch(src, /target:[^\n]*includes\("woco-net\.com"\)/, `${file}: a third classification rule`);
  }
});
