/**
 * Feed write retry — the 409 branch and the index cache (#120).
 *
 * A 409 from a feed write means "a chunk already exists at this index": with
 * one signer for every feed, that is a stale cached index, never a conflict.
 * The old branch cleared the cache and threw — healing the NEXT call, failing
 * this one. These tests pin: the decision table; that a stale cache costs one
 * re-discovery round trip and the write still lands; that a cache-miss write
 * on an existing feed no longer caches `1` (which is what made the very next
 * write 409 after every restart); and that a `fresh` 409 still throws.
 *
 * `writeFeedPage` is driven against a fake Bee installed through
 * `__setBeeForTests`; no network. The Etherna branch is covered at the
 * decision level only — its SOC poster is module-bound.
 */

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Topic, FeedIndex, type Bee } from "@ethersphere/bee-js";
import { decideFeedWriteRetry, type FeedWriteErrorFacts } from "../src/lib/swarm/feed-write-retry.js";

// ---------------------------------------------------------------------------
// Decision table (pure)
// ---------------------------------------------------------------------------

describe("decideFeedWriteRetry", () => {
  const base: FeedWriteErrorFacts = {
    status: undefined,
    transient: false,
    attempt: 0,
    maxAttempts: 5,
    etherna: false,
    fresh: false,
  };
  const d = (over: Partial<FeedWriteErrorFacts>) => decideFeedWriteRetry({ ...base, ...over }).action;

  test("transient errors retry at the same index until the last attempt", () => {
    assert.equal(d({ transient: true, status: 503 }), "retry-transient");
    assert.equal(d({ transient: true, attempt: 3 }), "retry-transient");
    assert.equal(d({ transient: true, attempt: 4 }), "throw");
  });

  test("404 on the first attempt resets to index 0 — WoCo bee only", () => {
    assert.equal(d({ status: 404 }), "reset-to-zero");
    assert.equal(d({ status: 404, attempt: 1 }), "throw");
    assert.equal(d({ status: 404, etherna: true }), "throw");
  });

  test("409 re-discovers the index, on both rails, until the last attempt", () => {
    assert.equal(d({ status: 409 }), "rediscover-index");
    assert.equal(d({ status: 409, etherna: true }), "rediscover-index");
    assert.equal(d({ status: 409, attempt: 3 }), "rediscover-index");
    assert.equal(d({ status: 409, attempt: 4 }), "throw");
  });

  test("409 on a `fresh` write is a violated assumption, not a stale cache — throw", () => {
    assert.equal(d({ status: 409, fresh: true }), "throw");
  });

  test("anything else throws", () => {
    assert.equal(d({ status: 400 }), "throw");
    assert.equal(d({ status: 402 }), "throw");
    assert.equal(d({}), "throw");
  });
});

// ---------------------------------------------------------------------------
// writeFeedPage against a fake Bee
// ---------------------------------------------------------------------------

let swarm: typeof import("../src/config/swarm.js");
let feeds: typeof import("../src/lib/swarm/feeds.js");

interface FakeBeeOpts {
  /** The feed's real next index as bee's lookup would report it. */
  realNext: bigint;
  /** Indexes that already hold a chunk (a write there 409s). */
  occupied?: Set<bigint>;
  /** Make EVERY write 409 regardless (a broken lookup). */
  always409?: boolean;
}

/** What the fake records: the index each upload was attempted at (`null` = "no index, bee-js discovers"). */
function fakeBee(o: FakeBeeOpts) {
  const attempts: Array<bigint | null> = [];
  const landed: bigint[] = [];
  const occupied = o.occupied ?? new Set<bigint>();
  let realNext = o.realNext;
  const conflict = () => Object.assign(new Error("chunk already exists"), { status: 409 });
  const bee = {
    makeFeedWriter() {
      return {
        async uploadPayload(_batch: string, _data: Uint8Array, opts?: { index?: FeedIndex }) {
          const idx = opts?.index === undefined ? null : opts.index.toBigInt();
          attempts.push(idx);
          if (o.always409) throw conflict();
          // bee-js without an index: findNextIndex → the real next.
          const at = idx ?? realNext;
          if (occupied.has(at)) throw conflict();
          occupied.add(at);
          landed.push(at);
          if (at >= realNext) realNext = at + 1n;
          return { reference: "00".repeat(32) };
        },
      };
    },
    makeFeedReader() {
      return {
        async downloadPayload() {
          return {
            payload: { toUint8Array: () => new Uint8Array(4096) },
            feedIndex: FeedIndex.fromBigInt(realNext - 1n),
            feedIndexNext: FeedIndex.fromBigInt(realNext),
          };
        },
      };
    },
  } as unknown as Bee;
  return { bee, attempts, landed, occupied };
}

const TOPIC = Topic.fromString("woco/test/feed-write-retry");
const PAGE = new Uint8Array(4096);

before(async () => {
  // Env is read at import; the signer is only needed to build a writer.
  process.env.FEED_PRIVATE_KEY = "0x" + "11".repeat(32);
  process.env.POSTAGE_BATCH_ID = "ab".repeat(32);
  swarm = await import("../src/config/swarm.js");
  feeds = await import("../src/lib/swarm/feeds.js");
  feeds.__feedWriteTestHooks.setBaseBackoffMs(0);
});

beforeEach(() => {
  feeds.__feedWriteTestHooks.clearCache();
  swarm.__setBeeForTests(null);
});

describe("writeFeedPage", () => {
  test("primed cache: writes at the cached index and advances it", async () => {
    const f = fakeBee({ realNext: 7n });
    swarm.__setBeeForTests(f.bee);
    await feeds.readFeedPage(TOPIC); // primes the cache to 7
    assert.equal(feeds.__feedWriteTestHooks.cachedNextIndex(TOPIC), 7n);
    await feeds.writeFeedPage(TOPIC, PAGE);
    assert.deepEqual(f.attempts, [7n]);
    assert.equal(feeds.__feedWriteTestHooks.cachedNextIndex(TOPIC), 8n);
  });

  test("STALE cache (a read re-primed it backwards): the 409 re-discovers and the write lands", async () => {
    // The feed is really at 7 (indexes 0..6 hold chunks); a stale read left 5 in the cache.
    const occupied = new Set<bigint>([0n, 1n, 2n, 3n, 4n, 5n, 6n]);
    const f = fakeBee({ realNext: 7n, occupied });
    swarm.__setBeeForTests(f.bee);
    // Prime to 5 through a reader that lags.
    f.bee.makeFeedReader = (() => ({
      async downloadPayload() {
        return {
          payload: { toUint8Array: () => new Uint8Array(4096) },
          feedIndex: FeedIndex.fromBigInt(4n),
          feedIndexNext: FeedIndex.fromBigInt(5n),
        };
      },
    })) as unknown as Bee["makeFeedReader"];
    await feeds.readFeedPage(TOPIC);
    assert.equal(feeds.__feedWriteTestHooks.cachedNextIndex(TOPIC), 5n);

    await feeds.writeFeedPage(TOPIC, PAGE); // used to throw here
    assert.deepEqual(f.attempts, [5n, null], "409 at 5, then re-discovery (no index)");
    assert.deepEqual(f.landed, [7n], "bee-js discovered the real next and the write landed");
    // We did not choose the landed index, so the cache is left for a read/lookup to set.
    assert.equal(feeds.__feedWriteTestHooks.cachedNextIndex(TOPIC), undefined);
  });

  test("cache-miss write on an EXISTING feed: lands via discovery and does NOT cache `1`", async () => {
    // This is the post-restart shape: nothing has read the feed yet.
    const occupied = new Set<bigint>([0n, 1n, 2n]);
    const f = fakeBee({ realNext: 3n, occupied });
    swarm.__setBeeForTests(f.bee);
    await feeds.writeFeedPage(TOPIC, PAGE);
    assert.deepEqual(f.attempts, [null]);
    assert.deepEqual(f.landed, [3n]);
    assert.equal(feeds.__feedWriteTestHooks.cachedNextIndex(TOPIC), undefined, "the old code cached 1 here");
    // And the NEXT write does not 409 (the old code's write at 1 would have).
    await feeds.writeFeedPage(TOPIC, PAGE);
    assert.deepEqual(f.attempts, [null, null]);
    assert.deepEqual(f.landed, [3n, 4n]);
  });

  test("`fresh` write that 409s throws — the caller's 'never written' was false", async () => {
    const f = fakeBee({ realNext: 1n, occupied: new Set([0n]) });
    swarm.__setBeeForTests(f.bee);
    await assert.rejects(feeds.writeFeedPage(TOPIC, PAGE, { fresh: true }), (e: { status?: number }) => e.status === 409);
    assert.deepEqual(f.attempts, [0n], "no re-discovery for a fresh write");
    assert.equal(feeds.__feedWriteTestHooks.cachedNextIndex(TOPIC), undefined, "stale value dropped");
  });

  test("a lookup that keeps pointing at an occupied index gives up after the attempt budget", async () => {
    const f = fakeBee({ realNext: 0n, always409: true });
    swarm.__setBeeForTests(f.bee);
    await feeds.readFeedPage(TOPIC); // primes to 0
    await assert.rejects(feeds.writeFeedPage(TOPIC, PAGE), (e: { status?: number }) => e.status === 409);
    // attempt 0 at the cached index, then four re-discoveries, then throw.
    assert.equal(f.attempts.length, 5);
    assert.deepEqual(f.attempts.slice(1), [null, null, null, null]);
    assert.equal(feeds.__feedWriteTestHooks.cachedNextIndex(TOPIC), undefined);
  });

  test("a later write after a 409 recovery is healed by the next read", async () => {
    const occupied = new Set<bigint>([0n, 1n, 2n]);
    const f = fakeBee({ realNext: 3n, occupied });
    swarm.__setBeeForTests(f.bee);
    await feeds.writeFeedPage(TOPIC, PAGE); // discovery → 3
    await feeds.readFeedPage(TOPIC); // reader now says next = 4
    assert.equal(feeds.__feedWriteTestHooks.cachedNextIndex(TOPIC), 4n);
    await feeds.writeFeedPage(TOPIC, PAGE);
    assert.deepEqual(f.attempts, [null, 4n]);
  });
});
