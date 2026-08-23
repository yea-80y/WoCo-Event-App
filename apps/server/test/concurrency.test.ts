/**
 * Bounded parallel map (#201).
 *
 * The property under test is the CEILING. `Promise.all` over a per-slot RPC call
 * is correct and passes every functional test — it just issues one request per
 * ticket sold, all at once, which is why a sold-out event was the one that broke
 * its organiser's dashboard. So these assert peak in-flight, not just results.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mapWithConcurrency, SLOT_READ_CONCURRENCY } from "../src/lib/util/concurrency.js";

/** Runs `fn` while tracking how many calls are in flight at once. */
function tracking<T, R>(fn: (item: T, index: number) => Promise<R>) {
  const state = { inFlight: 0, peak: 0, calls: 0 };
  const wrapped = async (item: T, index: number): Promise<R> => {
    state.calls++;
    state.inFlight++;
    state.peak = Math.max(state.peak, state.inFlight);
    try {
      return await fn(item, index);
    } finally {
      state.inFlight--;
    }
  };
  return { state, wrapped };
}

const tick = () => new Promise((r) => setImmediate(r));

test("never exceeds the limit, however large the input", async () => {
  const { state, wrapped } = tracking(async (n: number) => {
    await tick();
    return n * 2;
  });
  const items = Array.from({ length: 1000 }, (_, i) => i);

  const out = await mapWithConcurrency(items, 8, wrapped);

  assert.equal(state.peak, 8, "peak in-flight must equal the limit, not the input size");
  assert.equal(state.calls, 1000, "every item must still be visited");
  assert.equal(out[999], 1998);
});

test("results keep INPUT order even when completion order is reversed", async () => {
  // Callers index into the result array by slot number, so a fast slot 9
  // must not land in slot 0's position.
  const out = await mapWithConcurrency(
    [5, 4, 3, 2, 1],
    5,
    async (delay, i) => {
      await new Promise((r) => setTimeout(r, delay * 5));
      return `i${i}`;
    },
  );
  assert.deepEqual(out, ["i0", "i1", "i2", "i3", "i4"]);
});

test("an empty input starts no workers and resolves empty", async () => {
  const { state, wrapped } = tracking(async (n: number) => n);
  const out = await mapWithConcurrency([], 8, wrapped);
  assert.deepEqual(out, []);
  assert.equal(state.calls, 0);
  assert.equal(state.peak, 0);
});

test("a limit above the input size does not over-spawn", async () => {
  const { state, wrapped } = tracking(async (n: number) => {
    await tick();
    return n;
  });
  await mapWithConcurrency([1, 2, 3], 500, wrapped);
  assert.equal(state.peak, 3, "workers are capped by the input, not the limit");
});

test("a limit of one runs strictly in sequence", async () => {
  const { state, wrapped } = tracking(async (n: number) => {
    await tick();
    return n;
  });
  await mapWithConcurrency([1, 2, 3, 4], 1, wrapped);
  assert.equal(state.peak, 1);
});

test("a rejecting item rejects the whole map — callers must catch per item", async () => {
  // Documents the contract both routes rely on: they attach `.catch` INSIDE the
  // mapped function, so one unreadable slot degrades to null rather than failing
  // the organiser's entire order list.
  await assert.rejects(
    () => mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("slot read failed");
      return n;
    }),
    /slot read failed/,
  );
});

test("catching inside the mapped function degrades one item, not the batch", async () => {
  const out = await mapWithConcurrency([1, 2, 3], 2, async (n) =>
    n === 2
      ? await Promise.reject(new Error("slot read failed")).catch(() => null)
      : n,
  );
  assert.deepEqual(out, [1, null, 3], "the bad slot is null; its neighbours survive");
});

test("the slot-read ceiling is a small positive integer", () => {
  assert.ok(Number.isInteger(SLOT_READ_CONCURRENCY));
  assert.ok(SLOT_READ_CONCURRENCY > 0 && SLOT_READ_CONCURRENCY <= 32);
});
