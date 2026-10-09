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
  assert.match(r, /&&\s*\(await manifestFollows\(deploy\.feedManifestHash, expected\)\);/, "the target's manifest checked here");
  assert.match(LIVE, /await repoint\(site\.subEnsLabel, dep\.data, !!dep\.data\.multisiteFeed, \{\s*owner: keys\.feedSigner\.address,\s*topic: multisiteFeedTopic\(entry\.siteId\),/);
  assert.match(LIVE, /await repoint\(feed\.subEnsLabel, dep\.data, dep\.feedSigned && dep\.data\.feedOwner === "client", \{\s*owner: keys\.feedSigner\.address,\s*topic: eventPageFeedTopic\(e\.eventId\),/);
  const m = body("async function manifestFollows(");
  assert.match(m, /calculateCacAddress\(raw\.subarray\(0, 8\), raw\.subarray\(8\)\)\) !== hash\) return false;/, "hash-checked on this device");
  assert.match(m, /feed\.owner === expected\.owner/);
  assert.match(m, /feed\.topic === bytesToHex\(keccak_256\(utf8ToBytes\(expected\.topic\)\)\)/);
});

test("own feeds are read thorough, and an unreadable or inconclusive one stops the removal", () => {
  const r = body("async function readOwn<");
  assert.match(r, /thorough: true/);
  assert.match(r, /if \(res\.status === "unavailable" \|\| \(res\.status === "found" && !res\.scanClean\)\) \{\s*throw/);
});
