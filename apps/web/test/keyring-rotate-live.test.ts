/**
 * The removal's live steps (#186), pinned on their source: a name is re-pointed with no
 * tap only when every value is one this device knows, and the organiser's own feeds are
 * read thorough and clean before anything is copied.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const LIVE = readFileSync(new URL("../src/lib/keyring/rotate-live.ts", import.meta.url), "utf8");
function body(sig: string): string {
  const start = LIVE.indexOf(sig);
  assert.ok(start >= 0, `${sig} must exist`);
  return LIVE.slice(start, LIVE.indexOf("\n  }\n", start));
}

test("a name is re-pointed only for the organiser's own label, a deploy this device signed, at that deploy's feed", () => {
  const r = body("async function repoint(");
  for (const cond of [
    /!!ownLabel &&/,
    /p\.label === ownLabel &&/,
    /signedUnderNewKey &&/,
    /p\.target === deploy\.feedManifestHash &&/,
    /pointerBlockedReason\("passkey", "site", "client", true, ownLabel\) === null/,
  ]) {
    assert.match(r, cond);
  }
  assert.match(r, /if \(!ok\) throw new Error/);
  assert.match(r, /pointNameAt\(ownLabel!, p\.target!/, "the label signed is ours, never the reply's");
  assert.match(LIVE, /await repoint\(site\.subEnsLabel, dep\.data, !!dep\.data\.multisiteFeed\);/);
  assert.match(LIVE, /await repoint\(feed\.subEnsLabel, dep\.data, dep\.feedSigned && dep\.data\.feedOwner === "client"\);/);
});

test("own feeds are read thorough, and an unreadable or inconclusive one stops the removal", () => {
  const r = body("async function readOwn<");
  assert.match(r, /thorough: true/);
  assert.match(r, /if \(res\.status === "unavailable" \|\| \(res\.status === "found" && !res\.scanClean\)\) \{\s*throw/);
});
