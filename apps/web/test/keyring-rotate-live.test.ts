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
  // The label signed is ours, never the reply's; the target is checked against the
  // manifest worked out here for the new signer and topic (no fetch).
  assert.match(r, /await pointNameAtFeed\(ownLabel!, p\.target!, expected, \(typed\) => h\.signTypedDataAsHolder\(typed\)\);/);
  assert.doesNotMatch(LIVE, /\bpointNameAt\(|fetch\(/, "no unchecked pointer, no manifest fetch");
  assert.match(LIVE, /await repoint\(site\.subEnsLabel, dep\.data, !!dep\.data\.multisiteFeed, \{\s*owner: keys\.feedSigner\.address,\s*topic: multisiteFeedTopic\(entry\.siteId\),/);
  assert.match(LIVE, /await repoint\(feed\.subEnsLabel, dep\.data, dep\.feedSigned && dep\.data\.feedOwner === "client", \{\s*owner: keys\.feedSigner\.address,\s*topic: eventPageFeedTopic\(e\.eventId\),/);
});

test("own feeds are read thorough, and an unreadable or inconclusive one stops the removal", () => {
  const r = body("async function readOwn<");
  assert.match(r, /thorough: true/);
  assert.match(r, /if \(res\.status === "unavailable" \|\| \(res\.status === "found" && !res\.scanClean\)\) \{\s*throw/);
});

test("the server is counted as told only when it names the ring just set", () => {
  assert.match(LIVE, /if \(res\.data\?\.ref !== ctx\.ring\) throw new Error/);
});

test("the events' key move: found from the chain, never the platform index; never blocks the flip, never clears unread", () => {
  const due = body("async function organiserKeyDue(");
  assert.match(due, /await scanOwnLedger2Events\(parent, deployment\)/, "the chain is the source");
  assert.doesNotMatch(due, /getEventsByCreator/, "the platform's index is no source of the move");
  assert.match(due, /planOrganiserKeyMoves\(states, parent, key, Date\.now\(\) \/ 1000\)/);
  // The after-step clears only on a whole read; the flip carries what it has.
  assert.match(due, /if \(opts\.strict && !scan\.complete\) throw/);
  assert.match(due, /if \(states === "error"\) \{\s*if \(opts\.strict\) throw[^\n]*\n\s*return \{ ledger: deployment\.address, ids: \[\] \};/);
  // The own-feed ids only add: an unreadable feed never stops the move.
  assert.match(due, /\} catch \{\s*\/\/ The chain is the source; the feeds only add to it\.\s*\}/);
  assert.match(LIVE, /organiserKeyDue\(keys\.organiserKey, \{ ownFeedSigners: \[h\.oldSigner\.address\], strict: false \}\)/, "the flip");
  assert.match(LIVE, /organiserKeyDue\(keys\.organiserKey, \{ ownFeedSigners: \[\], strict: true \}\)/, "the after-step");
});
