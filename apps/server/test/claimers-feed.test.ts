/**
 * Paged claimers feed — spill and move-on-overflow planners. A single JSON
 * page tops out around 30 realistic entries (post-gzip 4096-byte limit), so
 * these planners are what let a series grow past that. Pure: IO is injected
 * through the `fits` callback.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  planClaimerAppend,
  planOrderRefAttach,
  encodeFits,
  CLAIMERS_SOFT_CAP,
} from "../src/lib/event/claimers-feed.js";
import type { ClaimerEntry, ClaimersFeed } from "@woco/shared";

const SERIES = "series-test";
const NOW = "2026-08-01T12:00:00.000Z";

function entry(edition: number, orderRef?: string): ClaimerEntry {
  return {
    edition,
    claimerAddress: `wallet:${"ab".repeat(32)}`,
    claimedRef: "c".repeat(64),
    claimedAt: NOW,
    ...(orderRef ? { orderRef } : {}),
  };
}

function page(editions: number[], withOrderRef = false): ClaimersFeed {
  return {
    v: 1,
    seriesId: SERIES,
    claimers: editions.map((e) => entry(e, withOrderRef ? "d".repeat(64) : undefined)),
    updatedAt: NOW,
  };
}

const alwaysFits = () => true;
const neverFits = () => false;

describe("planClaimerAppend", () => {
  it("first entry opens page 0", () => {
    const plan = planClaimerAppend([], SERIES, entry(1), NOW, alwaysFits);
    assert.equal(plan?.pageIdx, 0);
    assert.equal(plan?.feed.claimers.length, 1);
  });

  it("appends to the tail page under the soft cap", () => {
    const plan = planClaimerAppend([page([1, 2])], SERIES, entry(3), NOW, alwaysFits);
    assert.equal(plan?.pageIdx, 0);
    assert.equal(plan?.feed.claimers.length, 3);
  });

  it("is idempotent by edition across ALL pages", () => {
    assert.equal(planClaimerAppend([page([1]), page([2])], SERIES, entry(1), NOW, alwaysFits), null);
    assert.equal(planClaimerAppend([page([1]), page([2])], SERIES, entry(2), NOW, alwaysFits), null);
  });

  it("spills to a new page at the soft cap", () => {
    const full = page(Array.from({ length: CLAIMERS_SOFT_CAP }, (_, i) => i + 1));
    const plan = planClaimerAppend([full], SERIES, entry(99), NOW, alwaysFits);
    assert.equal(plan?.pageIdx, 1);
    assert.equal(plan?.feed.claimers.length, 1);
  });

  it("spills when the candidate page no longer encodes, even under the cap", () => {
    const plan = planClaimerAppend([page([1, 2])], SERIES, entry(3), NOW, neverFits);
    assert.equal(plan?.pageIdx, 1);
  });

  it("real encoder: 100 sequential appends never exceed a page's 4096 bytes", () => {
    const pages: ClaimersFeed[] = [];
    for (let e = 1; e <= 100; e++) {
      const plan = planClaimerAppend(pages, SERIES, entry(e, "d".repeat(64)), NOW, encodeFits);
      assert.ok(plan, `edition ${e} rejected as duplicate`);
      pages[plan.pageIdx] = plan.feed;
    }
    assert.equal(pages.flatMap((p) => p.claimers).length, 100);
    assert.ok(pages.length >= Math.ceil(100 / CLAIMERS_SOFT_CAP));
    for (const p of pages) assert.ok(encodeFits(p));
  });
});

describe("planOrderRefAttach", () => {
  const isMatch = (c: ClaimerEntry) => c.claimerAddress.startsWith("wallet:");
  const REF = "e".repeat(64);

  it("attaches in place when the rewrite fits", () => {
    const plan = planOrderRefAttach([page([1, 2])], isMatch, REF, NOW, alwaysFits);
    assert.equal(plan.matched, 2);
    assert.equal(plan.writes.length, 1);
    assert.equal(plan.moved.length, 0);
    assert.ok(plan.writes[0].feed.claimers.every((c) => c.orderRef === REF));
  });

  it("never touches entries that already carry an orderRef", () => {
    const plan = planOrderRefAttach([page([1, 2], true)], isMatch, REF, NOW, alwaysFits);
    assert.equal(plan.matched, 0);
    assert.equal(plan.writes.length, 0);
  });

  it("moves grown entries out of a page that no longer fits", () => {
    const plan = planOrderRefAttach([page([1, 2, 3])], isMatch, REF, NOW, neverFits);
    assert.equal(plan.matched, 3);
    assert.equal(plan.writes.length, 1);
    assert.equal(plan.writes[0].feed.claimers.length, 0); // shed from the page
    assert.equal(plan.moved.length, 3);
    assert.ok(plan.moved.every((c) => c.orderRef === REF));
  });

  it("a mixed page sheds only the grown entries", () => {
    const mixed: ClaimersFeed = {
      v: 1,
      seriesId: SERIES,
      claimers: [entry(1, "f".repeat(64)), entry(2)],
      updatedAt: NOW,
    };
    const plan = planOrderRefAttach([mixed], isMatch, REF, NOW, neverFits);
    assert.equal(plan.matched, 1);
    assert.deepEqual(plan.writes[0].feed.claimers.map((c) => c.edition), [1]);
    assert.deepEqual(plan.moved.map((c) => c.edition), [2]);
  });
});
