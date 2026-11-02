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
  // The chain is the source (organiserKeysDue's behaviour: organiser-event-scan.test.ts).
  assert.match(due, /return organiserKeysDue\(parent, key, deployment, \{ strict: opts\.strict, extraIds \}\)/);
  assert.doesNotMatch(due, /getEventsByCreator/, "the platform's index is no source of the move");
  // The own-feed ids only add: an unreadable feed never stops the move.
  assert.match(due, /\} catch \{\s*\/\/ The chain is the source; the feeds only add to it\.\s*\}/);
  assert.match(LIVE, /organiserKeyDue\(keys\.organiserKey, \{ ownFeedSigners: \[h\.oldSigner\.address\], strict: false \}\)/, "the flip");
  assert.match(LIVE, /organiserKeyDue\(keys\.organiserKey, \{ ownFeedSigners: \[\], strict: true \}\)/, "the after-step");
  // The flip's op carries fewer than one op may: a gas refusal must not refuse the removal.
  assert.match(LIVE, /due\.ids\.slice\(0, ORGANISER_KEY_IDS_WITH_FLIP\)/);
});

test("events left on an old key are moved from ANY passkey at its unlock, once per ring, never on a partial read", () => {
  const KEYS = readFileSync(new URL("../src/lib/keyring/account-keys.ts", import.meta.url), "utf8");
  assert.match(KEYS, /void removalLeftHere\(h, seedAddr\)\.then\(\(\) => organiserKeysLeftBehind\(h, seedAddr\)\)/);
  const start = KEYS.indexOf("async function moveKeysLeftBehind(");
  const fn = KEYS.slice(start, KEYS.indexOf("\n}\n", start));
  assert.match(fn, /\(u\.chain\?\.gen \?\? 0\) < 1\) return/, "generation 0 never moved");
  assert.match(fn, /h\.deviceRole\(\) \|\| !\(await h\.currentKeysConfirmed\(\)\)\) return/, "only a co-owner on confirmed keys");
  assert.match(fn, /if \(await hasPendingRotation\(seedAddr\)\) return/, "a removal finishing here moves them itself");
  assert.match(fn, /organiserKeysDue\(u\.parent, key, deployment, \{ strict: true \}\)/, "only on a whole read");
  assert.match(fn, /derived\.privateKey\.fill\(0\)/, "only the address is kept");
  // The mark only after every move, and only for the ring it checked.
  const moves = fn.indexOf("flows.moveOrganiserKey(");
  const mark = fn.indexOf("setItem(organiserKeysMark(seedAddr), ring)");
  assert.ok(moves > 0 && mark > moves, "marked before the moves landed");
  // The chain's anchor, re-read before each op and the mark: a removal elsewhere mid-scan
  // must never see its events moved back to the key the removed passkey holds.
  assert.match(fn, /\(await readAnchor\(h, u\.parent, \{ fresh: true \}\)\) === ring/);
  assert.match(fn, /if \(!\(await stillHere\(\)\)\) return;\s*await flows\.moveOrganiserKey\(/);
  assert.match(fn, /if \(await stillHere\(\)\) globalThis\.localStorage\?\.setItem\(organiserKeysMark\(seedAddr\), ring\)/);
  assert.ok(fn.indexOf("if (enrolling) await enrolling") < fn.indexOf("const ring = "), "the ring is read before this passkey's enrolment lands");
  assert.match(KEYS, /if \(movingKeys\) await movingKeys\.catch\(\(\) => \{\}\);/, "a removal waits for a catch-up op");
});
