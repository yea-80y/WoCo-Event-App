import { test } from "node:test";
import assert from "node:assert/strict";
import { settleInBatches } from "../src/lib/utils/settle-in-batches.js";

test("never runs more than the limit at once", async () => {
  let running = 0;
  let peak = 0;
  await settleInBatches([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running--;
    return n;
  });
  assert.ok(peak <= 4, `peak was ${peak}`);
  assert.ok(peak > 1, "ran one at a time — the limit is not being used");
});

test("keeps input order and settles a failure without losing the others", async () => {
  const results = await settleInBatches([1, 2, 3, 4, 5], 2, async (n) => {
    await new Promise((resolve) => setTimeout(resolve, (6 - n) * 2));
    if (n === 3) throw new Error("three");
    return n * 2;
  });
  assert.equal(results.length, 5);
  assert.deepEqual(results[0], { status: "fulfilled", value: 2 });
  assert.equal(results[2].status, "rejected");
  assert.deepEqual(results[4], { status: "fulfilled", value: 10 });
});

test("an empty list settles to an empty list", async () => {
  assert.deepEqual(await settleInBatches([], 4, async (n: number) => n), []);
});
