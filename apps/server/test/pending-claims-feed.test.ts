/**
 * Paged pending-claims feed — spill and move-on-overflow planners. Pending
 * entries are bigger than claimer entries (sealed address + two Swarm refs +
 * UUID) so a single page holds ~16 of them, and decided requests are kept as
 * history, so the feed only grows. Pure: IO is injected through `fits`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import {
  planPendingAppend,
  planPendingDecision,
  mergePendingPages,
  readPendingPagesStrict,
  encodeFits,
  PENDING_SOFT_CAP,
} from "../src/lib/event/pending-claims-feed.js";
import { encodeJsonFeed } from "../src/lib/swarm/feeds.js";
import type { PendingClaimEntry, PendingClaimsFeed } from "@woco/shared";

const SERIES = "series-test";
const NOW = "2026-08-01T12:00:00.000Z";
const DECIDED_AT = "2026-08-02T09:00:00.000Z";

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

/** Realistic wallet pending entry: hashed handle + AES-GCM sealed address. */
function entry(id: string, over: Partial<PendingClaimEntry> = {}): PendingClaimEntry {
  return {
    pendingId: id,
    claimerKey: `wallet:${hex(32)}`,
    claimerSealed: randomBytes(12 + 16 + 42).toString("base64"),
    requestedAt: NOW,
    orderRef: hex(32),
    claimedRef: hex(32),
    status: "pending",
    ...over,
  };
}

function page(entries: PendingClaimEntry[]): PendingClaimsFeed {
  return { v: 1, seriesId: SERIES, pending: entries, updatedAt: NOW };
}

const ids = (n: number, prefix = "p") => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
const alwaysFits = () => true;
const neverFits = () => false;

describe("planPendingAppend", () => {
  it("first entry opens page 0", () => {
    const plan = planPendingAppend([], SERIES, entry("p1"), NOW, alwaysFits);
    assert.equal(plan?.pageIdx, 0);
    assert.equal(plan?.feed.pending.length, 1);
  });

  it("appends to the tail page under the soft cap", () => {
    const pages = [page([entry("p1")]), page([entry("p2")])];
    const plan = planPendingAppend(pages, SERIES, entry("p3"), NOW, alwaysFits);
    assert.equal(plan?.pageIdx, 1);
    assert.deepEqual(plan?.feed.pending.map((e) => e.pendingId), ["p2", "p3"]);
  });

  it("is idempotent by pendingId across ALL pages", () => {
    const pages = [page([entry("p1")]), page([entry("p2")])];
    assert.equal(planPendingAppend(pages, SERIES, entry("p1"), NOW, alwaysFits), null);
    assert.equal(planPendingAppend(pages, SERIES, entry("p2"), NOW, alwaysFits), null);
  });

  it("spills to a new page at the soft cap", () => {
    const full = page(ids(PENDING_SOFT_CAP).map((id) => entry(id)));
    const plan = planPendingAppend([full], SERIES, entry("overflow"), NOW, alwaysFits);
    assert.equal(plan?.pageIdx, 1);
    assert.equal(plan?.feed.pending.length, 1);
  });

  it("spills when the candidate page no longer encodes, even under the cap", () => {
    const plan = planPendingAppend([page([entry("p1")])], SERIES, entry("p2"), NOW, neverFits);
    assert.equal(plan?.pageIdx, 1);
  });

  it("real encoder: 100 sequential requests never exceed a page's 4096 bytes", () => {
    const pages: PendingClaimsFeed[] = [];
    for (const id of ids(100)) {
      const plan = planPendingAppend(pages, SERIES, entry(id), NOW, encodeFits);
      assert.ok(plan, `${id} rejected as duplicate`);
      pages[plan.pageIdx] = plan.feed;
    }
    assert.equal(pages.flatMap((p) => p.pending).length, 100);
    assert.ok(pages.length >= Math.ceil(100 / PENDING_SOFT_CAP));
    for (const p of pages) assert.ok(encodeFits(p));
  });

  it("real encoder: a single page of undecided entries would blow the limit", () => {
    // Guards the soft cap's premise — without it one page is the whole feed.
    const oversized = page(ids(40).map((id) => entry(id)));
    assert.equal(encodeFits(oversized), false);
  });
});

describe("planPendingDecision", () => {
  it("stamps the decision in place when the rewrite fits", () => {
    const pages = [page([entry("p1"), entry("p2")])];
    const plan = planPendingDecision(
      pages,
      "p2",
      { status: "approved", decidedAt: DECIDED_AT },
      NOW,
      alwaysFits,
    );
    assert.equal(plan.found, true);
    assert.equal(plan.moved, null);
    assert.equal(plan.writes.length, 1);
    const [p1, p2] = plan.writes[0].feed.pending;
    assert.equal(p1.status, "pending");
    assert.equal(p2.status, "approved");
    assert.equal(p2.decidedAt, DECIDED_AT);
  });

  it("finds the entry on a later page", () => {
    const pages = [page([entry("p1")]), page([entry("p2")])];
    const plan = planPendingDecision(pages, "p2", { status: "rejected" }, NOW, alwaysFits);
    assert.equal(plan.writes[0].pageIdx, 1);
  });

  it("reports not-found for an unknown id", () => {
    const plan = planPendingDecision([page([entry("p1")])], "nope", { status: "approved" }, NOW, alwaysFits);
    assert.equal(plan.found, false);
    assert.equal(plan.writes.length, 0);
  });

  it("never re-decides an already-decided entry", () => {
    const decided = page([entry("p1", { status: "approved", decidedAt: DECIDED_AT })]);
    const plan = planPendingDecision(
      [decided],
      "p1",
      { status: "rejected", decidedAt: NOW },
      NOW,
      alwaysFits,
    );
    assert.equal(plan.found, false);
  });

  it("sheds the grown entry when its page no longer fits", () => {
    const pages = [page([entry("p1"), entry("p2")])];
    const plan = planPendingDecision(
      pages,
      "p1",
      { status: "rejected", decidedAt: DECIDED_AT, rejectionReason: "x".repeat(500) },
      NOW,
      neverFits,
    );
    assert.equal(plan.found, true);
    assert.deepEqual(plan.writes[0].feed.pending.map((e) => e.pendingId), ["p2"]);
    assert.equal(plan.moved?.pendingId, "p1");
    assert.equal(plan.moved?.status, "rejected");
    assert.equal(plan.moved?.rejectionReason?.length, 500);
  });

  it("a shed entry re-appends onto the tail, keeping the sealed address intact", () => {
    const pages = [page(ids(PENDING_SOFT_CAP).map((id) => entry(id)))];
    const target = pages[0].pending[0];
    const plan = planPendingDecision(
      pages,
      target.pendingId,
      { status: "rejected", decidedAt: DECIDED_AT },
      NOW,
      neverFits,
    );
    const working = [...pages];
    working[plan.writes[0].pageIdx] = plan.writes[0].feed;
    // Same `fits` as the shed — that is what stops the entry being re-appended
    // onto the very page that just rejected it (it is now under the soft cap).
    const appended = planPendingAppend(working, SERIES, plan.moved!, NOW, neverFits);
    assert.equal(appended?.pageIdx, 1);
    // The seal is AAD-bound to {seriesId, pendingId}, not to a page — moving it
    // must not alter the ciphertext.
    assert.equal(appended?.feed.pending[0].claimerSealed, target.claimerSealed);
  });

  it("real encoder: every entry on a full page can be rejected with a max-length reason", () => {
    // The end state the soft cap exists to survive — via in-place rewrites where
    // they fit and moves where they don't, nothing is lost and no page overflows.
    let pages: PendingClaimsFeed[] = [];
    const requested = ids(PENDING_SOFT_CAP * 3).map((id) => entry(id));
    for (const e of requested) {
      const plan = planPendingAppend(pages, SERIES, e, NOW, encodeFits);
      pages[plan!.pageIdx] = plan!.feed;
    }

    for (const e of requested) {
      const plan = planPendingDecision(
        pages,
        e.pendingId,
        {
          status: "rejected",
          decidedAt: DECIDED_AT,
          // High-entropy text — gzip cannot rescue a page full of these.
          rejectionReason: randomBytes(400).toString("base64").slice(0, 500),
        },
        NOW,
        encodeFits,
      );
      assert.equal(plan.found, true, `${e.pendingId} not found`);
      const working = [...pages];
      for (const w of plan.writes) working[w.pageIdx] = w.feed;
      if (plan.moved) {
        const ap = planPendingAppend(working, SERIES, plan.moved, NOW, encodeFits);
        assert.ok(ap, "moved entry was rejected as a duplicate");
        working[ap.pageIdx] = ap.feed;
      }
      pages = working;
      for (const p of pages) assert.ok(encodeFits(p), "a page exceeded 4096 bytes");
    }

    const all = pages.flatMap((p) => p.pending);
    assert.equal(all.length, requested.length);
    assert.ok(all.every((e) => e.status === "rejected" && e.rejectionReason));
    // Sealed addresses survive every move unchanged.
    for (const before of requested) {
      const after = all.find((e) => e.pendingId === before.pendingId);
      assert.equal(after?.claimerSealed, before.claimerSealed);
    }
  });
});

describe("readPendingPagesStrict — fail-closed", () => {
  // Every read-modify-write on this feed goes through here. A writer that
  // mistakes a transient read failure for "page absent" REPLACES the page,
  // dropping every request already on it.
  const ok = (feed: PendingClaimsFeed) =>
    ({ status: "ok", data: encodeJsonFeed(feed) }) as const;
  const absent = { status: "absent" } as const;
  const error = { status: "error", error: new Error("bee 503") } as const;

  const readerFor = (results: Array<ReturnType<typeof ok> | typeof absent | typeof error>) =>
    async (_id: string, i: number) => results[i] ?? absent;
  const NO_RETRY: number[] = [];

  it("returns every contiguous page", async () => {
    const read = await readPendingPagesStrict(
      SERIES,
      readerFor([ok(page([entry("p1")])), ok(page([entry("p2")])), absent]),
    );
    assert.equal(read.status, "ok");
    assert.equal(read.status === "ok" && read.pages.length, 2);
  });

  it("an unwritten feed is ok-and-empty, not an error", async () => {
    const read = await readPendingPagesStrict(SERIES, readerFor([absent]));
    assert.equal(read.status, "ok");
    assert.deepEqual(read.status === "ok" && read.pages, []);
  });

  it("aborts when page 0 errors — never reports an empty feed", async () => {
    const read = await readPendingPagesStrict(SERIES, readerFor([error]), NO_RETRY);
    assert.equal(read.status, "error");
  });

  it("retries a transient page error before giving up", async () => {
    // On the paid approval path this read runs AFTER the claims slot is
    // written, so a blip that reaches the caller refunds a buyer whose seat is
    // already reserved — and strands that seat.
    let calls = 0;
    const flaky = async (_id: string, i: number) => {
      if (i > 0) return absent; // one-page feed
      calls++;
      return calls === 1 ? error : ok(page([entry("p1")]));
    };
    const read = await readPendingPagesStrict(SERIES, flaky, [1, 1]);
    assert.equal(read.status, "ok");
    assert.equal(read.status === "ok" && read.pages.length, 1);
    assert.equal(calls, 2);
  });

  it("gives up after the configured retries", async () => {
    let calls = 0;
    const failing = async () => {
      calls++;
      return error;
    };
    const read = await readPendingPagesStrict(SERIES, failing, [1, 1]);
    assert.equal(read.status, "error");
    assert.equal(calls, 3); // initial attempt + 2 retries
  });

  it("aborts on a mid-chain error instead of returning a short view", async () => {
    // Silently returning pages 0-1 would let a writer treat page 2 as free and
    // overwrite it, orphaning its requests with their claims slots reserved.
    const read = await readPendingPagesStrict(
      SERIES,
      readerFor([ok(page([entry("p1")])), ok(page([entry("p2")])), error]),
      NO_RETRY,
    );
    assert.equal(read.status, "error");
  });

  it("treats a present-but-undecodable page as an error", async () => {
    const corrupt = { status: "ok", data: new Uint8Array(4096).fill(0x7b) } as const;
    const read = await readPendingPagesStrict(SERIES, readerFor([corrupt]));
    assert.equal(read.status, "error");
  });
});

describe("mergePendingPages", () => {
  it("is null when the feed was never written", () => {
    assert.equal(mergePendingPages(SERIES, []), null);
  });

  it("flattens every page in order and reports the latest updatedAt", () => {
    const older: PendingClaimsFeed = { ...page([entry("p1")]), updatedAt: NOW };
    const newer: PendingClaimsFeed = { ...page([entry("p2"), entry("p3")]), updatedAt: DECIDED_AT };
    const merged = mergePendingPages(SERIES, [older, newer]);
    assert.deepEqual(merged?.pending.map((e) => e.pendingId), ["p1", "p2", "p3"]);
    assert.equal(merged?.updatedAt, DECIDED_AT);
    assert.equal(merged?.seriesId, SERIES);
  });

  it("survives a real round-trip through pages built by the planners", () => {
    const pages: PendingClaimsFeed[] = [];
    for (const id of ids(25)) {
      const plan = planPendingAppend(pages, SERIES, entry(randomUUID() + id), NOW, encodeFits);
      pages[plan!.pageIdx] = plan!.feed;
    }
    assert.equal(mergePendingPages(SERIES, pages)?.pending.length, 25);
  });
});
