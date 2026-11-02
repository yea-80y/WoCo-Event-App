/**
 * Whole-list actions - CSV export, an email to every attendee, the door list -
 * never act on a partial attendee list without saying so (#965,
 * list-completeness.ts).
 *
 * MUTATION: let a row still loading count as done, count an erased row as
 * missing, let a retrying row block for good (loading instead of a gap), let an
 * export or a send or a door list go out while loading, skip the confirm on gaps,
 * or drop the CSV's Details column, and a case below goes red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DETAIL_CSV, listGate, rowDetail, shortfall } from "../src/lib/creator/dashboard/list-completeness.js";

const BOX = { encryptedOrder: { v: 2, enc: "e", ct: "c" } } as never;
const NONE = {} as never;

test("rowDetail: opened beats everything but erasure", () => {
  assert.equal(rowDetail({ erased: true } as never, true, "ready", false), "erased");
  assert.equal(rowDetail(BOX, true, undefined, false), "details");
  assert.equal(rowDetail(NONE, true, undefined, false), "details");
});

test("rowDetail: a box on the row is loading while opening, locked while the keys are, else could not be opened", () => {
  assert.equal(rowDetail(BOX, false, undefined, true), "loading");
  assert.equal(rowDetail(BOX, false, undefined, false, true), "locked");
  assert.equal(rowDetail(BOX, false, undefined, false), "unopened");
  assert.equal(listGate(["locked", "details"]).kind, "gaps");
  assert.match((listGate(["locked"]) as { why: string }).why, /^1 locked - unlock to include them$/);
});

test("rowDetail: a row without its box follows the queue", () => {
  assert.equal(rowDetail(NONE, false, "queued", false), "loading");
  assert.equal(rowDetail(NONE, false, "fetching", false), "loading");
  assert.equal(rowDetail(NONE, false, "ready", false), "loading", "fetched, not merged yet");
  assert.equal(rowDetail(NONE, false, "retrying", false), "unavailable");
  assert.equal(rowDetail(NONE, false, "missing", false), "not-found");
  assert.equal(rowDetail(NONE, false, "unreadable", false), "unreadable");
  assert.equal(rowDetail(NONE, false, undefined, false), "not-found", "no order stored for this ticket");
});

test("listGate: anything still loading holds the whole list", () => {
  assert.deepEqual(listGate(["details", "loading", "not-found"]), { kind: "loading", done: 1, total: 3 });
});

test("listGate: complete when every row that should have details has them; erased rows are left out", () => {
  assert.deepEqual(listGate(["details", "erased", "details"]), { kind: "ready", total: 2 });
  assert.deepEqual(listGate([]), { kind: "ready", total: 0 });
});

test("listGate: gaps name how many and why; a retrying row is a gap, never an endless wait", () => {
  const g = listGate(["details", "not-found", "not-found", "unavailable", "unreadable", "unopened", "erased"]);
  assert.deepEqual(g, {
    kind: "gaps",
    missing: 5,
    total: 6,
    why: "2 not found, 1 unavailable right now, 1 unreadable, 1 could not be opened",
  });
});

test("shortfall reads as people count", () => {
  assert.equal(shortfall({ missing: 12, total: 1340 }), "12 of 1,340");
});

test("the CSV says why a row has no details, and nothing when it has them", () => {
  assert.equal(DETAIL_CSV.details, "");
  assert.equal(DETAIL_CSV["not-found"], "Not found");
  assert.equal(DETAIL_CSV.erased, "Erased on request");
});

const DASH = readFileSync(new URL("../src/lib/creator/dashboard/Dashboard.svelte", import.meta.url), "utf-8");
const PANEL = readFileSync(new URL("../src/lib/creator/dashboard/CheckinPanel.svelte", import.meta.url), "utf-8");
const body = (src: string, sig: string) => src.slice(src.indexOf(sig), src.indexOf("\n  }\n", src.indexOf(sig)));

test("CSV: no export while loading; a confirm naming the shortfall on gaps; a Details column", () => {
  const csv = body(DASH, "function downloadCSV(");
  assert.match(csv, /if \(gate\.kind === "loading"\) return;/);
  assert.match(csv, /gate\.kind === "gaps" &&\s*!confirm\(\s*`Details for \$\{shortfall\(gate\)\} tickets are not in this export \(\$\{gate\.why\}\)/);
  assert.match(csv, /"Claimed At", "Details",/);
  assert.match(csv, /DETAIL_CSV\[details\[i\]\],/);
  assert.match(DASH, /disabled=\{csvGate\.kind === "loading"\}/);
});

test("Broadcast: no send while loading; the confirm says who will not receive it", () => {
  const send = body(DASH, "async function handleSendBroadcast(");
  // A resume re-sends to recipients the server holds: only a NEW send waits.
  const gate = send.indexOf('if (!resumeOf && gate.kind === "loading") {');
  assert.ok(gate > 0 && gate < send.indexOf("startBroadcast("), "checked before anything is sent");
  assert.match(send, /!resumeOf && gate\.kind === "gaps"\s*\?/);
  assert.match(send, /tickets are missing \(\$\{gate\.why\}\), so those ticket holders will NOT receive this\./);
  assert.match(send, /\$\{crossingWarning\}\$\{gapWarning\}`\)\)/);
  assert.match(DASH, /\|\| broadcastGate\.kind === "loading"/);
});

test("Door list: waits while loading, and goes out with gaps only on a second tap", () => {
  const ready = body(PANEL, "function rosterReady(): boolean {");
  assert.match(ready, /if \(rosterGate\.kind === "loading"\) \{\s*workError = [^\n]*\n\s*return false;/);
  assert.match(ready, /if \(rosterGate\.kind === "gaps" && !confirmGaps\) \{\s*confirmGaps = true;\s*return false;/);
  for (const fn of ["async function generatePass(", "async function refreshRoster("]) {
    const b = body(PANEL, fn);
    const decrypt = b.indexOf("if (needsDecrypt) await onEnsureDecrypted();");
    const gate = b.indexOf("if (!rosterReady()) return;");
    const push = b.indexOf("await pushCheckinRoster(");
    assert.ok(decrypt > 0 && gate > decrypt && push > gate, `${fn}: open first, then the gate, then the push`);
  }
  assert.match(DASH, /rosterGate=\{listGate\(rowDetailsOf\(ordersResponse\.orders\)\)\}/);
});

test("a locked row reads as locked in every gate, not as 'could not be opened'", () => {
  assert.match(DASH, /rowDetail\(o, decryptedOrders\.has\(position\.get\(o\) \?\? -1\), detailState\(o\), decrypting, ordersLocked\)/);
});
