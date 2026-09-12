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
  deployedHash: "",
  attempts: 0,
};

const state = (over: Partial<SubEnsLinkInput>) => subEnsLinkState({ ...base, ...over });

test("not claimed: nothing to open, nothing to say, nothing to poll", () => {
  for (const singleName of [true, false]) {
    for (const deployedHash of ["", HASH_A]) {
      for (const contentHash of [null, HASH_A]) {
        assert.deepEqual(
          state({ claimed: false, singleName, deployedHash, contentHash }),
          { showOpen: false, note: null, pollAgain: false },
        );
      }
    }
  }
});

test("profile name with no contenthash: identity note, never a link", () => {
  assert.deepEqual(
    state({ singleName: true, contentHash: null, deployedHash: "" }),
    { showOpen: false, note: "identity", pollAgain: false },
  );
});

test("claimed, never deployed: registering, no link, no poll", () => {
  assert.deepEqual(
    state({ contentHash: null, deployedHash: "" }),
    { showOpen: false, note: "registering", pollAgain: false },
  );
});

test("deploy out, contenthash not landed yet: updating, no link, keep polling", () => {
  assert.deepEqual(
    state({ contentHash: null, deployedHash: HASH_A, attempts: 1 }),
    { showOpen: false, note: "updating", pollAgain: true },
  );
});

test("bound reached with nothing on chain: gave up, no link, stop polling", () => {
  assert.deepEqual(
    state({ contentHash: null, deployedHash: HASH_A, attempts: SUB_ENS_POLL_MAX_ATTEMPTS }),
    { showOpen: false, note: "gave-up", pollAgain: false },
  );
  // One short of the bound is still the waiting state — off-by-one here means
  // either a poll that never stops or a link that gives up a read early.
  assert.deepEqual(
    state({ contentHash: null, deployedHash: HASH_A, attempts: SUB_ENS_POLL_MAX_ATTEMPTS - 1 }),
    { showOpen: false, note: "updating", pollAgain: true },
  );
});

test("name resolves to the previous publish: link stays, stale-version note, keep polling", () => {
  assert.deepEqual(
    state({ contentHash: HASH_A, deployedHash: HASH_B, attempts: 2 }),
    { showOpen: true, note: "stale-version", pollAgain: true },
  );
});

test("name agrees with the last deploy: link, no note, stop polling", () => {
  assert.deepEqual(
    state({ contentHash: HASH_A, deployedHash: HASH_A, attempts: 3 }),
    { showOpen: true, note: null, pollAgain: false },
  );
});

test("resolves with no deploy from this screen: link, no note, no poll", () => {
  // An existing name pointed at content elsewhere (or a site opened on another
  // device). There is a certificate to get, and nothing to wait for.
  assert.deepEqual(
    state({ contentHash: HASH_A, deployedHash: "" }),
    { showOpen: true, note: null, pollAgain: false },
  );
});

test("a stale-version standoff still stops at the bound", () => {
  assert.deepEqual(
    state({ contentHash: HASH_A, deployedHash: HASH_B, attempts: SUB_ENS_POLL_MAX_ATTEMPTS }),
    { showOpen: true, note: "stale-version", pollAgain: false },
  );
});

test("hash spelling is not content: 0x and case do not fake a stale version", () => {
  // The encoder takes either case and the decoder lower-cases, so a difference
  // in spelling would otherwise read as a difference in content and poll out
  // the whole budget over nothing.
  assert.deepEqual(
    state({ contentHash: HASH_A, deployedHash: "0x" + HASH_A.toUpperCase() }),
    { showOpen: true, note: null, pollAgain: false },
  );
});

test("undefined contenthash is treated as absent, not as a hash", () => {
  assert.deepEqual(
    state({ contentHash: undefined, deployedHash: HASH_A, attempts: 0 }),
    { showOpen: false, note: "updating", pollAgain: true },
  );
});

test("the poll is bounded in both dimensions", () => {
  // 24 × 5s = two minutes: an Arbitrum write plus margin. The bound matters
  // because the contenthash transaction is fire-and-forget on the server — if it
  // was refused there is nothing to wait for, and each read is an authenticated
  // chain scan.
  assert.equal(SUB_ENS_POLL_MAX_ATTEMPTS, 24);
  assert.equal(SUB_ENS_POLL_INTERVAL_MS, 5000);
});
