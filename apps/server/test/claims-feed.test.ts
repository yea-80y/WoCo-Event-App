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

import {
  readClaimsPageStrict,
  selectFreeSlot,
  type ClaimsPagePair,
} from "../src/lib/event/claims-feed.js";

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
  const reader = (result: unknown) => async () => result as never;

  it("returns the page bytes when the read succeeds", async () => {
    const data = claimsPage([1]);
    const page = await readClaimsPageStrict(SERIES, 0, reader({ status: "ok", data }));
    assert.equal(page, data);
  });

  it("returns null for a genuinely absent page — the normal state of a new series", async () => {
    const page = await readClaimsPageStrict(SERIES, 0, reader({ status: "absent" }));
    assert.equal(page, null);
  });

  it("THROWS on a read error rather than reporting an empty page", async () => {
    await assert.rejects(
      () => readClaimsPageStrict(SERIES, 0, reader({ status: "error", error: new Error("bee 503") })),
      /Could not read the claims feed/,
    );
  });

  it("does not leak the underlying error text to the caller", async () => {
    // The message reaches the HTTP client via routes/claims.ts.
    await assert.rejects(
      () => readClaimsPageStrict(SERIES, 0, reader({ status: "error", error: new Error("http://bee-node:1633 refused") })),
      (err: Error) => !err.message.includes("bee-node"),
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

  it("a sold-out page never re-allocates an edition just because a later page is free", () => {
    // Regression shape of the bug: page 0 full, page 1 empty. Allocation must
    // move forward, never reopen page 0's editions.
    const full = claimsPage(Array.from({ length: 128 }, (_, i) => i));
    for (let i = 0; i < 5; i++) {
      const free = selectFreeSlot([
        { claims: full, editions: editionsPage() },
        { claims: null, editions: editionsPage() },
      ]);
      assert.equal(free?.page, 1);
    }
  });
});
