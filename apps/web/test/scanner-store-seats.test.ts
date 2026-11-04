/**
 * The roster's manual check-in applies the camera's seat rule (`doorSeat`): there is no
 * QR to verify, but a seated ticket with no seat now is refused and records nothing, and
 * one whose seat the list could not read is not admitted. A seated ticket in its seat,
 * and any general-admission ticket, are admitted as before.
 *
 * MUTATION: drop either seat check in `manualCheckin` and its case goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { NO_SEAT_INDEX } from "@woco/shared";
import { makePass, openTab, packFor, removeCompiledStore, resetWorld, server, seriesId, storeEvent } from "./scanner-store-harness.ts";

test.after(removeCompiledStore);
test.beforeEach(resetWorld);

const A = "event-seats";

async function seatedEvent() {
  const pass = makePass(A, "s".repeat(32));
  await storeEvent(pass, {
    v: 2,
    series: [{
      seriesId: seriesId(A), name: "Reserved", totalSupply: 10, seated: true,
      seats: [4, NO_SEAT_INDEX, null], seatLabels: [{ area: "Stalls", row: "A", seat: 5 }, null, null],
    }],
  });
}

test("manual check-in: no seat is refused and records nothing; unread is not admitted; a seat is", async (t) => {
  await seatedEvent();
  const scanner = await openTab(t);
  assert.equal(await scanner.openEvent(A), true);

  assert.deepEqual(await scanner.manualCheckin(seriesId(A), 2), { kind: "no-seat" });
  const unread = await scanner.manualCheckin(seriesId(A), 3);
  assert.equal(unread.kind, "cant-confirm");
  assert.equal(scanner.isCheckedIn(seriesId(A), 2), undefined, "no seat left no check-in");
  assert.equal(scanner.isCheckedIn(seriesId(A), 3), undefined, "unread left no check-in");

  assert.deepEqual(await scanner.manualCheckin(seriesId(A), 1), { kind: "checked-in" });
  assert.deepEqual(scanner.seatOf(seriesId(A), 1), { kind: "seat", seat: { area: "Stalls", row: "A", seat: 5 } });
});

test("the scanner asks for the seat-aware list: X-Scanner-Pack 2 on every pack request", async (t) => {
  const pass = makePass(A, "p".repeat(32));
  await storeEvent(pass);
  server.handlers.set("/pack", () => Response.json({ ok: true, data: packFor(A) }));
  const scanner = await openTab(t);
  assert.equal(await scanner.openEvent(A), true);
  await scanner.refreshPack();
  const asked = server.requests.filter((r) => r.url.pathname.endsWith("/pack"));
  assert.ok(asked.length > 0);
  for (const r of asked) assert.equal(r.headers["X-Scanner-Pack"], "2");
});

test("manual check-in of general admission is unchanged", async (t) => {
  const pass = makePass(A, "g".repeat(32));
  await storeEvent(pass);
  const scanner = await openTab(t);
  assert.equal(await scanner.openEvent(A), true);
  assert.deepEqual(await scanner.manualCheckin(seriesId(A), 1), { kind: "checked-in" });
  assert.deepEqual(scanner.seatOf(seriesId(A), 1), { kind: "unseated" });
});
