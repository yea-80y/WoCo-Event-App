/**
 * Delete-safety fail-closed gate (#243).
 *
 * After the v1 rail cut (#207) the on-chain read is the ONLY ticket ledger, so
 * `assertNoOrders` is all that stands between a sold-out event and deletion —
 * and the client pre-disables the delete button whenever it knows of orders,
 * so nothing exercises these branches in practice. What these tests pin is the
 * absent-vs-unknown distinction that decides everything: a chain read that
 * returns null (contract reverted EventNotFound — a verified zero, nothing can
 * ever have minted) ALLOWS, while a chain read that THROWS (RPC outage)
 * REFUSES with a retryable error. One inverted conditional would let an
 * outage delete a sold-out event, silently.
 *
 * #435 adds the other half: WHICH on-chain event is counted. The id now comes
 * from the server's own registration record, never from the feed's
 * `onChainEventId` — that field is creator-signed input, and pointing a sold
 * series at an empty on-chain event made the count read zero.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { SeriesSummary } from "@woco/shared";
import type { OnChainEvent } from "../src/lib/chain/event-contract.js";
import {
  assertNoOrders,
  DeleteBlockedError,
  type DeleteSafetyDeps,
} from "../src/lib/event/delete-safety.js";

/** Any event id — these tests only care that it is threaded through (#377). */
const EVENT_ID = "evt-delete-safety";

const CHAIN_ID = 421614;
const ONCHAIN_ID = `0x${"ab".repeat(32)}`;

function series(over: Partial<SeriesSummary> = {}): SeriesSummary {
  return {
    seriesId: "ser-1",
    name: "General",
    description: "",
    totalSupply: 100,
    price: 1000,
    onChainEventId: ONCHAIN_ID,
    ...over,
  };
}

function onChain(nextSlot: bigint): OnChainEvent {
  return {
    totalSupply: 100n,
    nextSlot,
    organiser: "0xorganiser",
    manifestRef: `0x${"00".repeat(32)}`,
  };
}

/** Deps harness: verified-zero everywhere unless overridden; records chain reads.
 *  `lookupOnChainEventId` stands in for the server's registration record — the
 *  only source of the id that is counted (#435). */
function harness(over: Partial<DeleteSafetyDeps> = {}) {
  const reads: Array<{ onChainEventId: string; chainId: number }> = [];
  const deps: DeleteSafetyDeps = {
    getOnChainEvent: async (onChainEventId, chainId) => {
      reads.push({ onChainEventId, chainId });
      return onChain(0n);
    },
    getActiveChainId: () => CHAIN_ID,
    heldFor: () => 0,
    lookupOnChainEventId: () => ONCHAIN_ID,
    ...over,
  };
  return { deps, reads };
}

// ---------------------------------------------------------------------------
// The allow side: zero must be VERIFIED, and null IS a verified zero
// ---------------------------------------------------------------------------

test("verified zero on-chain and no holds → delete allowed, ledger actually consulted", async () => {
  const { deps, reads } = harness();
  await assertNoOrders(EVENT_ID, [series()], deps);
  // The gate must have asked the contract — an allow without a read is fail-open.
  assert.deepEqual(reads, [{ onChainEventId: ONCHAIN_ID, chainId: CHAIN_ID }]);
});

test("null chain read (EventNotFound) is a verified zero → delete allowed", async () => {
  // getOnChainEventV2 returns null for exactly one thing: the contract
  // reverted EventNotFound(), so nothing can ever have minted.
  const { deps } = harness({ getOnChainEvent: async () => null });
  await assertNoOrders(EVENT_ID, [series()], deps);
});

// ---------------------------------------------------------------------------
// The refuse side, branch by branch
// ---------------------------------------------------------------------------

test("a THROWING chain read refuses — an RPC outage is never read as zero claims", async () => {
  const { deps } = harness({
    getOnChainEvent: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  await assert.rejects(assertNoOrders(EVENT_ID, [series()], deps), (err: unknown) => {
    // NOT a DeleteBlockedError: the route maps that to a definitive 409,
    // while "Could not verify" maps to a retryable 503. Transport failure
    // means UNKNOWN, and unknown must refuse without pretending to know why.
    assert.ok(!(err instanceof DeleteBlockedError));
    assert.ok(err instanceof Error);
    assert.equal(err.message, "Could not verify order status — try again");
    return true;
  });
});

test("series with no on-chain record → blocked; there is no ledger to consult", async () => {
  const { deps, reads } = harness({ lookupOnChainEventId: () => null });
  await assert.rejects(
    assertNoOrders(EVENT_ID, [series({ onChainEventId: undefined })], deps),
    (err: unknown) => {
      assert.ok(err instanceof DeleteBlockedError);
      assert.equal(err.blockers.length, 1);
      assert.match(err.blockers[0], /no on-chain record/);
      return true;
    },
  );
  assert.equal(reads.length, 0);
});

test("claimed tickets block, with the count surfaced", async () => {
  const { deps } = harness({ getOnChainEvent: async () => onChain(3n) });
  await assert.rejects(assertNoOrders(EVENT_ID, [series()], deps), (err: unknown) => {
    assert.ok(err instanceof DeleteBlockedError);
    assert.deepEqual(err.blockers, [`"General": 3 ticket(s) issued`]);
    return true;
  });
});

test("live buyer holds block even when on-chain claims are zero", async () => {
  const { deps } = harness({ heldFor: () => 2 });
  await assert.rejects(assertNoOrders(EVENT_ID, [series()], deps), (err: unknown) => {
    assert.ok(err instanceof DeleteBlockedError);
    assert.deepEqual(err.blockers, [`"General": 2 seat(s) currently held by buyers`]);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Multi-series behaviour
// ---------------------------------------------------------------------------

test("blockers accumulate across series — the 409 reports every reason", async () => {
  const claimedId = `0x${"cd".repeat(32)}`;
  const { deps } = harness({
    getOnChainEvent: async (id) => onChain(id === claimedId ? 5n : 0n),
    lookupOnChainEventId: (_eventId, seriesId) =>
      seriesId === "ser-1" ? null : seriesId === "ser-2" ? claimedId : ONCHAIN_ID,
    // Asserting the event id here is the point: without it a wrong constant
    // threaded through assertNoOrders would pass unnoticed (#377).
    heldFor: (eventId, seriesId) => {
      assert.equal(eventId, EVENT_ID, "assertNoOrders must forward the event being deleted");
      return seriesId === "ser-3" ? 1 : 0;
    },
  });
  const all = [
    series({ seriesId: "ser-1", name: "Unregistered", onChainEventId: undefined }),
    series({ seriesId: "ser-2", name: "Sold", onChainEventId: claimedId }),
    series({ seriesId: "ser-3", name: "Held" }),
  ];
  await assert.rejects(assertNoOrders(EVENT_ID, all, deps), (err: unknown) => {
    assert.ok(err instanceof DeleteBlockedError);
    assert.equal(err.name, "DeleteBlockedError");
    assert.deepEqual(err.blockers, [
      `"Unregistered": series has no on-chain record — ticket count cannot be verified`,
      `"Sold": 5 ticket(s) issued`,
      `"Held": 1 seat(s) currently held by buyers`,
    ]);
    // The route serialises the message too — it must carry every reason.
    for (const b of err.blockers) assert.ok(err.message.includes(b));
    return true;
  });
});

test("a transport failure aborts outright — never demoted to one blocker among many", async () => {
  // Series 1 already produced a blocker; series 2's read then fails. The
  // plain Error must win: a partial blocker list would render as a complete,
  // definitive 409 while a count is actually UNKNOWN.
  const { deps } = harness({
    getOnChainEvent: async () => {
      throw new Error("timeout");
    },
    lookupOnChainEventId: (_eventId, seriesId) => (seriesId === "ser-1" ? null : ONCHAIN_ID),
  });
  const all = [
    series({ seriesId: "ser-1", name: "Unregistered", onChainEventId: undefined }),
    series({ seriesId: "ser-2", name: "Unknowable" }),
  ];
  await assert.rejects(assertNoOrders(EVENT_ID, all, deps), (err: unknown) => {
    assert.ok(!(err instanceof DeleteBlockedError));
    assert.ok(err instanceof Error);
    assert.equal(err.message, "Could not verify order status — try again");
    return true;
  });
});

// ---------------------------------------------------------------------------
// #435 — the count is taken at the RECORDED id, never the feed's
// ---------------------------------------------------------------------------

test("#435: a feed pointing a SOLD series at an empty on-chain event still blocks", async () => {
  // The attack this closes. The feed is the creator's client-signed SOC, so
  // `onChainEventId` is input: point a sold-out series at an on-chain event with
  // nothing minted and the old code counted zero and allowed the delete —
  // orphaning every paid ticket. The count must come from the server's record.
  const EMPTY_ID = `0x${"ee".repeat(32)}`;
  const seen: string[] = [];
  const { deps } = harness({
    getOnChainEvent: async (id) => {
      seen.push(id);
      return onChain(id === ONCHAIN_ID ? 7n : 0n);
    },
    lookupOnChainEventId: () => ONCHAIN_ID,
  });

  await assert.rejects(
    assertNoOrders(EVENT_ID, [series({ onChainEventId: EMPTY_ID })], deps),
    (err: unknown) => {
      assert.ok(err instanceof DeleteBlockedError);
      assert.deepEqual(err.blockers, [`"General": 7 ticket(s) issued`]);
      return true;
    },
  );
  // And the ledger was consulted at the recorded id, not the feed's — an assert
  // on the blocker alone would also pass if the feed id happened to read 7.
  assert.deepEqual(seen, [ONCHAIN_ID]);
});

test("#435: a feed id the server has NO record for blocks, and never reaches the chain", async () => {
  // The renamed-series case from the strip: the id may be perfectly real and
  // belong to somebody else. Unverifiable is not zero.
  const { deps, reads } = harness({ lookupOnChainEventId: () => null });

  await assert.rejects(
    assertNoOrders(EVENT_ID, [series({ onChainEventId: `0x${"fa".repeat(32)}` })], deps),
    (err: unknown) => {
      assert.ok(err instanceof DeleteBlockedError);
      assert.match(err.blockers[0], /no on-chain record/);
      return true;
    },
  );
  assert.equal(reads.length, 0, "a foreign feed id must not be read as this series' ledger");
});

test("#435: a recorded series with a MISSING feed id is still counted", async () => {
  // The mirror: the record is what matters, so a feed that carries no id at all
  // is neither blocked for that reason nor waved through. It is counted.
  const seen: string[] = [];
  const { deps } = harness({
    getOnChainEvent: async (id) => {
      seen.push(id);
      return onChain(2n);
    },
  });

  await assert.rejects(
    assertNoOrders(EVENT_ID, [series({ onChainEventId: undefined })], deps),
    (err: unknown) => {
      assert.ok(err instanceof DeleteBlockedError);
      assert.deepEqual(err.blockers, [`"General": 2 ticket(s) issued`]);
      return true;
    },
  );
  assert.deepEqual(seen, [ONCHAIN_ID]);
});
