/**
 * Claims feed reads + slot selection.
 *
 * The bug these cover: `readFeedPage` returns null for a Bee 404 AND for a
 * transient failure, and the slot scan read null as "128 free slots". A page
 * that merely failed to fetch therefore resold every edition on it and was then
 * republished from blank, erasing the claims it could not see.
 *
 * "Absent" genuinely does mean every slot is free — a claims page is only
 * written when its first ticket sells — so the fix is the strict reader's
 * three-way answer, not a null guard. These tests pin both halves of that.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { readClaimsPageStrict, selectFreeSlot } from "../src/lib/event/claims-feed.js";
import type { FeedReadStrictResult } from "../src/lib/swarm/feeds.js";

const SERIES = "series-test";

/** A 4096-byte binary page with 32-byte refs written at the given slots. */
function claimsPage(filledSlots: number[]): Uint8Array {
  const page = new Uint8Array(4096);
  for (const slot of filledSlots) page.set(randomBytes(32), slot * 32);
  return page;
}

/** An editions page: slot 0 of page 0 is the metadata ref, the rest are tickets. */
function editionsPage(count = 128): Uint8Array {
  return claimsPage(Array.from({ length: count }, (_, i) => i));
}

describe("readClaimsPageStrict", () => {
  /** Typed so a mistyped status literal fails at compile time. */
  const reader = (...results: FeedReadStrictResult[]) => {
    let i = 0;
    return async () => results[Math.min(i++, results.length - 1)];
  };
  const err = { status: "error", error: new Error("bee 503") } as const;
  const NO_RETRY: number[] = [];

  it("returns the page bytes when the read succeeds", async () => {
    const data = claimsPage([1]);
    const page = await readClaimsPageStrict(SERIES, 0, reader({ status: "ok", data }));
    assert.equal(page, data);
  });

  it("returns null for a genuinely absent page — the normal state of a new series", async () => {
    const page = await readClaimsPageStrict(SERIES, 0, reader({ status: "absent" }));
    assert.equal(page, null);
  });

  it("THROWS on a persistent read error rather than reporting an empty page", async () => {
    await assert.rejects(
      () => readClaimsPageStrict(SERIES, 0, reader(err), NO_RETRY),
      /Could not read the claims feed/,
    );
  });

  it("retries a transient error and returns the page once it reads", async () => {
    // On the card rail a throw here stops the batch and refunds the buyer, so a
    // one-off blip must not surface.
    const data = claimsPage([1, 2]);
    const page = await readClaimsPageStrict(SERIES, 0, reader(err, err, { status: "ok", data }), [1, 1]);
    assert.equal(page, data);
  });

  it("retries into an absent answer without throwing", async () => {
    const page = await readClaimsPageStrict(SERIES, 0, reader(err, { status: "absent" }), [1, 1]);
    assert.equal(page, null);
  });

  it("gives up after the configured number of retries", async () => {
    let calls = 0;
    const counting = async () => {
      calls++;
      return err;
    };
    await assert.rejects(() => readClaimsPageStrict(SERIES, 0, counting, [1, 1]), /try again/);
    assert.equal(calls, 3); // initial attempt + 2 retries
  });

  it("never retries an absent page — absent is an answer, not a failure", async () => {
    let calls = 0;
    const counting = async (): Promise<FeedReadStrictResult> => {
      calls++;
      return { status: "absent" };
    };
    assert.equal(await readClaimsPageStrict(SERIES, 0, counting, [1, 1]), null);
    assert.equal(calls, 1);
  });

  it("does not leak the underlying error text to the caller", async () => {
    // The message reaches the HTTP client via routes/claims.ts.
    const leaky = { status: "error", error: new Error("http://bee-node:1633 refused") } as const;
    await assert.rejects(
      () => readClaimsPageStrict(SERIES, 0, reader(leaky), NO_RETRY),
      (e: Error) => !e.message.includes("bee-node"),
    );
  });
});

describe("selectFreeSlot", () => {
  it("skips slot 0 of page 0 — it holds the series metadata, not a ticket", () => {
    const free = selectFreeSlot([{ claims: null, editions: editionsPage() }]);
    assert.equal(free?.page, 0);
    assert.equal(free?.slot, 1);
  });

  it("an absent claims page means every slot on it is unsold", () => {
    const free = selectFreeSlot([{ claims: null, editions: editionsPage() }]);
    assert.equal(free?.slot, 1);
    // Null is carried through so the write starts from a blank page, which is
    // correct ONLY because the reader never returns null for a failed fetch.
    assert.equal(free?.claimsPage, null);
  });

  it("picks the first zero slot after the sold ones", () => {
    const claims = claimsPage([1, 2, 3]);
    const free = selectFreeSlot([{ claims, editions: editionsPage() }]);
    assert.equal(free?.slot, 4);
    assert.equal(free?.claimsPage, claims);
  });

  it("fills a gap left by a rejected request", () => {
    // Reject zeroes the slot; the edition must become sellable again.
    const free = selectFreeSlot([{ claims: claimsPage([1, 3, 4]), editions: editionsPage() }]);
    assert.equal(free?.slot, 2);
  });

  it("moves to the next page when the first is full", () => {
    const fullPage0 = claimsPage(Array.from({ length: 128 }, (_, i) => i));
    const free = selectFreeSlot([
      { claims: fullPage0, editions: editionsPage() },
      { claims: null, editions: editionsPage() },
    ]);
    assert.equal(free?.page, 1);
    assert.equal(free?.slot, 0); // pages 1+ have no metadata slot
  });

  it("returns null when every edition is sold", () => {
    const full = claimsPage(Array.from({ length: 128 }, (_, i) => i));
    assert.equal(selectFreeSlot([{ claims: full, editions: editionsPage() }]), null);
  });

  it("skips a page whose editions are missing rather than allocating from it", () => {
    const free = selectFreeSlot([
      { claims: null, editions: null },
      { claims: null, editions: editionsPage() },
    ]);
    assert.equal(free?.page, 1);
  });

  it("returns the ticket ref sitting at the chosen slot", () => {
    const editions = editionsPage();
    const free = selectFreeSlot([{ claims: claimsPage([1]), editions }]);
    assert.equal(free?.slot, 2);
    const expected = Buffer.from(editions.subarray(2 * 32, 3 * 32)).toString("hex");
    assert.equal(free?.ticketRef, expected);
  });

  it("respects a partial editions page rather than running to slot 127", () => {
    // A series whose last page is not full: slots past the editions run must
    // never be allocated, or the claim would reference an empty ticket ref.
    const editions = editionsPage(5); // metadata + editions at slots 1..4
    const free = selectFreeSlot([{ claims: claimsPage([1, 2, 3, 4]), editions }]);
    assert.equal(free, null);
  });
});
