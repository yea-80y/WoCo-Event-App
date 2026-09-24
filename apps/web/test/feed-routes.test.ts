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

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
/** Comments stripped: several files name the wrong call in order to warn about it. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

test("each family is stamped where the table says - a move is a deliberate diff here", () => {
  const onEtherna = Object.entries(FEED_ROUTES).filter(([, r]) => r === ETHERNA_ROUTE).map(([k]) => k).sort();
  // Profiles have been Etherna since #617; event reads ask Etherna because new
  // events are stamped there. Everything else has not moved yet.
  assert.deepEqual(onEtherna, ["event", "profile"]);
  for (const [family, route] of Object.entries(FEED_ROUTES)) {
    assert.ok(route === ETHERNA_ROUTE || route === WOCO_ROUTE, `${family}: not one of the two routes`);
  }
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

test("no rail picks a raw route: every choice goes through the family table", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file);
    if (rel === "lib/swarm/gateways.ts") continue;
    if (/\b(?:ETHERNA_ROUTE|WOCO_ROUTE)\b/.test(code(readFileSync(file, "utf8")))) offenders.push(rel);
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
    if (rel === "lib/swarm/client-soc.ts") continue; // the primitive itself
    for (const args of callArgs(code(readFileSync(file, "utf8")), "probeSoc")) {
      seen++;
      if (!/gatewayUrl:/.test(args)) offenders.push(`${rel}: probeSoc(${args.replace(/\s+/g, " ")})`);
    }
  }
  assert.ok(seen >= 6, `only ${seen} probeSoc calls found - the scan is not seeing them`);
  assert.deepEqual(offenders, []);
});
