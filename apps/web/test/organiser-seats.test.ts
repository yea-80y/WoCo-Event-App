/**
 * The organiser's seat map rules (creator/seating/organiser-seats.ts) and the save
 * coalescing (seat-state-saver.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SeatHoldKind } from "@woco/shared/seating/state";
import {
  holdDelta, mergeDeltas, orgActions, orgAddAll, orgMark, orgSeat, orgSummary, orgToggle, putBackDelta, releaseDelta, withDelta,
  type OrgInputs,
} from "../src/lib/creator/seating/organiser-seats.js";
import { SAVE_AFTER_MS, SeatStateSaver } from "../src/lib/creator/seating/seat-state-saver.js";

// 0 free, 1 held (press), 2 sold (slot 7), 3 sold + house seat (slot 8), 4 in a basket,
// 5 emptied by a change (nonce 2), 6 unread, 7 free.
const X: OrgInputs = {
  taken: (k) => (k === 6 ? null : k === 2 || k === 3),
  holds: new Map<number, SeatHoldKind>([[1, "press"], [3, "house"]]),
  onHold: new Set([4]),
  emptied: new Map([[5, 2]]),
  slotOf: new Map([[2, 7], [3, 8]]),
};

test("each seat's status, most specific first", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((k) => orgSeat(k, X)), [
    { status: "free" },
    { status: "held", kind: "press" },
    { status: "sold", slot: 7, held: null },
    { status: "sold", slot: 8, held: "house" },
    { status: "basket" },
    { status: "offsale", nonce: 2 },
    { status: "unknown" },
  ]);
  const s = orgSummary(8, X);
  assert.deepEqual({ ...s, held: [...s.held] }, { sold: 2, held: [["press", 1]], heldTotal: 1, basket: 1, offsale: 1, free: 2, unknown: 1 });
});

test("marks: free keeps its band fill, a filter dims everything else", () => {
  assert.equal(orgMark(orgSeat(0, X), null), null);
  assert.equal(orgMark(orgSeat(1, X), null), "held");
  assert.equal(orgMark(orgSeat(2, X), null), "sold");
  assert.equal(orgMark(orgSeat(4, X), null), "basket");
  assert.equal(orgMark(orgSeat(5, X), null), "offsale");
  assert.equal(orgMark(orgSeat(1, X), { held: "guest" }), "dim");
  assert.equal(orgMark(orgSeat(1, X), { held: "press" }), "held");
  assert.equal(orgMark(orgSeat(0, X), "sold"), "dim");
});

test("a sold seat is a selection of its own; basket and unread seats are not selectable", () => {
  assert.deepEqual(orgToggle([], 0, X), [0]);
  assert.deepEqual(orgToggle([0, 1], 2, X), [2], "the ticket replaces the seats");
  assert.deepEqual(orgToggle([2], 0, X), [0], "a seat replaces the ticket");
  assert.deepEqual(orgToggle([0], 4, X), [0], "basket");
  assert.deepEqual(orgToggle([0], 6, X), [0], "unread");
  assert.deepEqual(orgToggle([0, 1], 1, X), [0], "toggles off");
  assert.deepEqual(orgAddAll([2], [0, 1, 2, 3, 4, 5], X), [0, 1, 5], "a row never pulls sold or basket seats in");
});

test("what a selection can do", () => {
  assert.deepEqual(orgActions([0, 1, 5], X), { hold: [0, 1, 5], release: [1], putBack: [5], ticket: null });
  assert.deepEqual(orgActions([3], X), { hold: [], release: [], putBack: [], ticket: { seat: 3, slot: 8 } }, "a sold house seat is never released");
});

test("deltas: hold, release, put back at the emptied nonce, merged later-wins", () => {
  assert.deepEqual([...holdDelta([0, 7], "guest").hold!], [[0, "guest"], [7, "guest"]]);
  assert.deepEqual(putBackDelta([5, 0], X), { confirm: new Map([[5, 2]]) }, "only emptied seats");
  const m = mergeDeltas(holdDelta([0, 7], "guest"), releaseDelta([7]));
  assert.deepEqual([...m.hold!], [[0, "guest"]]);
  assert.deepEqual(m.release, [7]);
  const back = mergeDeltas(releaseDelta([1]), holdDelta([1], "press"));
  assert.equal(back.release, undefined);
  const shown = withDelta(X.holds, X.emptied, mergeDeltas(holdDelta([0], "guest"), putBackDelta([5], X)));
  assert.equal(shown.holds.get(0), "guest");
  assert.equal(shown.emptied.has(5), false);
});

// ── Saver ────────────────────────────────────────────────────────────────────

function saverHarness(save: (d: unknown) => Promise<{ state: never; settled: boolean }>) {
  const timers: Array<() => void> = [];
  const saved: unknown[] = [];
  const s = new SeatStateSaver(
    {
      save: async (d) => {
        saved.push(d);
        return save(d);
      },
      setTimeout: (fn, ms) => {
        assert.equal(ms, SAVE_AFTER_MS);
        timers.push(fn);
        return timers.length;
      },
      clearTimeout: (id) => {
        timers[(id as number) - 1] = () => {};
      },
    },
    () => {},
    () => {},
  );
  return { s, timers, saved, fire: () => timers.splice(0).forEach((f) => f()) };
}

test("a burst of taps is one save, after the pause", async () => {
  const h = saverHarness(async () => ({ state: undefined as never, settled: true }));
  h.s.add(holdDelta([1], "house"));
  h.s.add(holdDelta([2], "house"));
  h.s.add(releaseDelta([1]));
  assert.equal(h.saved.length, 0);
  h.fire();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.saved.length, 1);
  assert.deepEqual(h.saved[0], { hold: new Map([[2, "house"]]), release: [1] });
  assert.deepEqual(h.s.status, { phase: "saved", settled: true });
});

test("changes made while a save runs go in the next; a failed save keeps its changes", async () => {
  let release!: () => void;
  let fail = false;
  const h = saverHarness(() => new Promise((res, rej) => {
    release = () => (fail ? rej(new Error("Couldn't read your seat holds just now - nothing was changed. Try again.")) : res({ state: undefined as never, settled: true }));
  }));
  h.s.add(holdDelta([1], "house"));
  h.fire();
  await new Promise((r) => setImmediate(r));
  h.s.add(holdDelta([2], "press"));
  assert.deepEqual([...h.s.unsaved().hold!], [[1, "house"], [2, "press"]], "both still shown as unsaved");
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.s.status.phase, "waiting", "the next save is scheduled");
  fail = true;
  h.fire();
  await new Promise((r) => setImmediate(r));
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.s.status.phase, "failed");
  assert.deepEqual([...h.s.pending.hold!], [[2, "press"]], "kept for Try again");
});
