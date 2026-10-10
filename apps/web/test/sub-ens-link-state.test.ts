/**
 * eth.limo issues a subname's TLS certificate on the FIRST request, and only if
 * the name already resolves to a contenthash. A click before that shows the
 * visitor a TLS error AND spends one of ~10 asks per 15 minutes for that
 * hostname, with the negative cached for 5 minutes — so a premature link does
 * not merely fail, it delays the moment the link could have worked (#500).
 *
 * These pin the one rule that protects that budget ("a chain read is the only
 * evidence") and the copy states that explain the link's absence, which are
 * otherwise only reachable through a runes component this runner cannot load.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  subEnsLinkState,
  SUB_ENS_POLL_MAX_ATTEMPTS,
  SUB_ENS_POLL_INTERVAL_MS,
  type SubEnsLinkInput,
} from "../src/lib/creator/builder/sub-ens-link-state.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const base: SubEnsLinkInput = {
  claimed: true,
  singleName: false,
  contentHash: null,
  targetHash: "",
  attempts: 0,
};

const state = (over: Partial<SubEnsLinkInput>) => subEnsLinkState({ ...base, ...over });

test("not claimed: nothing to open, nothing to say, nothing to poll", () => {
  for (const singleName of [true, false]) {
    for (const targetHash of ["", HASH_A]) {
      for (const contentHash of [null, HASH_A]) {
        assert.deepEqual(
          state({ claimed: false, singleName, targetHash, contentHash }),
          { showOpen: false, note: null, pollAgain: false },
        );
      }
    }
  }
});

test("profile name with no contenthash: identity note, never a link", () => {
  assert.deepEqual(
    state({ singleName: true, contentHash: null, targetHash: "" }),
    { showOpen: false, note: "identity", pollAgain: false },
  );
});

test("claimed, never deployed: registering, no link, no poll", () => {
  assert.deepEqual(
    state({ contentHash: null, targetHash: "" }),
    { showOpen: false, note: "registering", pollAgain: false },
  );
});

test("deploy out, contenthash not landed yet: updating, no link, keep polling", () => {
  assert.deepEqual(
    state({ contentHash: null, targetHash: HASH_A, attempts: 1 }),
    { showOpen: false, note: "updating", pollAgain: true },
  );
});

test("bound reached with nothing on chain: gave up, no link, stop polling", () => {
  assert.deepEqual(
    state({ contentHash: null, targetHash: HASH_A, attempts: SUB_ENS_POLL_MAX_ATTEMPTS }),
    { showOpen: false, note: "gave-up", pollAgain: false },
  );
  // One short of the bound is still the waiting state — off-by-one here means
  // either a poll that never stops or a link that gives up a read early.
  assert.deepEqual(
    state({ contentHash: null, targetHash: HASH_A, attempts: SUB_ENS_POLL_MAX_ATTEMPTS - 1 }),
    { showOpen: false, note: "updating", pollAgain: true },
  );
});

test("name resolves to the previous publish: link stays, stale-version note, keep polling", () => {
  assert.deepEqual(
    state({ contentHash: HASH_A, targetHash: HASH_B, attempts: 2 }),
    { showOpen: true, note: "stale-version", pollAgain: true },
  );
});

test("name agrees with the last deploy: link, no note, stop polling", () => {
  assert.deepEqual(
    state({ contentHash: HASH_A, targetHash: HASH_A, attempts: 3 }),
    { showOpen: true, note: null, pollAgain: false },
  );
});

test("resolves with no deploy from this screen: link, no note, no poll", () => {
  // An existing name pointed at content elsewhere (or a site opened on another
  // device). There is a certificate to get, and nothing to wait for.
  assert.deepEqual(
    state({ contentHash: HASH_A, targetHash: "" }),
    { showOpen: true, note: null, pollAgain: false },
  );
});

test("a stale-version standoff still stops at the bound", () => {
  assert.deepEqual(
    state({ contentHash: HASH_A, targetHash: HASH_B, attempts: SUB_ENS_POLL_MAX_ATTEMPTS }),
    { showOpen: true, note: "stale-version", pollAgain: false },
  );
});

test("hash spelling is not content: 0x and case do not fake a stale version", () => {
  // The encoder takes either case and the decoder lower-cases, so a difference
  // in spelling would otherwise read as a difference in content and poll out
  // the whole budget over nothing.
  assert.deepEqual(
    state({ contentHash: HASH_A, targetHash: "0x" + HASH_A.toUpperCase() }),
    { showOpen: true, note: null, pollAgain: false },
  );
});

test("undefined contenthash is treated as absent, not as a hash", () => {
  assert.deepEqual(
    state({ contentHash: undefined, targetHash: HASH_A, attempts: 0 }),
    { showOpen: false, note: "updating", pollAgain: true },
  );
});

test("the poll is bounded in both dimensions", () => {
  // 24 × 5s = two minutes: an Arbitrum write plus margin. The bound matters
  // because the pointer write waits on the holder's signature — if it never
  // comes there is nothing to wait for, and each read is an authenticated
  // chain scan.
  assert.equal(SUB_ENS_POLL_MAX_ATTEMPTS, 24);
  assert.equal(SUB_ENS_POLL_INTERVAL_MS, 5000);
});

test("a site name bound to the site FEED: a republish leaves nothing to wait for", () => {
  // v2.2 (#599) points a site name at the feed manifest, which no publish
  // changes. Comparing against the new CONTENT hash instead read every publish
  // as "Updating to the latest version." and spent the whole poll budget.
  const FEED = HASH_A;
  assert.deepEqual(
    state({ contentHash: FEED, targetHash: FEED, attempts: 1 }),
    { showOpen: true, note: null, pollAgain: false },
  );
});

test("the site builder hands the picker its FEED manifest, and shows no gateway link", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/lib/creator/builder/MultiSiteBuilder.svelte", import.meta.url)),
    "utf8",
  );
  const picker = src.slice(src.indexOf("<SubENSPicker"), src.indexOf("/>", src.indexOf("<SubENSPicker")));
  assert.match(picker, /targetHash=\{feedHash\}/);
  // #576: the deploy result's siteUrl is a gateway path, never shown.
  assert.doesNotMatch(src, /href=\{deployedUrl\}/);
});
