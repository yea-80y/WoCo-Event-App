/**
 * The door's decision for a genuine ticket (#641). A ticket is admitted ONCE
 * across every scanner: with several scanners that means nothing but a confirmed
 * server admission is ever green, and a device on a dead pass admits nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CheckinRecord } from "@woco/shared";
import { admit, doorModeOf, OFFLINE_MESSAGE, withConfirmed, type AdmitInput } from "../src/lib/scanner/admission.js";
import type { ClaimAnswer } from "../src/lib/scanner/claim.js";

const HOLDER: CheckinRecord = { seriesId: "ser-1", edition: 7, at: "2026-09-26T20:00:00.000Z", deviceId: "otherdevice01", method: "scan" };

function input(over: Partial<AdmitInput> = {}): AdmitInput & { calls: { mark: number; claim: number } } {
  const calls = { mark: 0, claim: 0 };
  return {
    mode: "several",
    passDead: null,
    online: true,
    claimInFlight: false,
    known: undefined,
    markLocally: async () => { calls.mark++; return null; },
    claimAtServer: async (): Promise<ClaimAnswer> => { calls.claim++; return { kind: "admitted", record: HOLDER }; },
    ...over,
    calls,
  };
}

test("a pack that names no mode is 'several' - the mode that cannot admit twice", () => {
  assert.equal(doorModeOf({}), "several");
  assert.equal(doorModeOf(null), "several");
  assert.equal(doorModeOf({ doorMode: "several" }), "several");
  assert.equal(doorModeOf({ doorMode: "single" }), "single");
});

test("several: offline is 'couldn't confirm' - never a local admission", async () => {
  const i = input({ online: false });
  const a = await admit(i);
  assert.deepEqual(a, { kind: "cant-confirm", message: OFFLINE_MESSAGE });
  assert.equal(i.calls.mark, 0, "several-mode must never consume a local nullifier");
  assert.equal(i.calls.claim, 0);
});

test("several: green only when the server admits", async () => {
  const ok = input();
  assert.equal((await admit(ok)).kind, "admitted");
  assert.equal(ok.calls.mark, 0);

  for (const answer of [
    { kind: "cant-confirm", message: "No answer from WoCo - scan again" },
    { kind: "pass-dead", message: "Door pass revoked" },
  ] as ClaimAnswer[]) {
    const i = input({ claimAtServer: async () => answer });
    const a = await admit(i);
    assert.equal(a.kind, "cant-confirm", `${answer.kind} must not admit`);
    assert.equal(i.calls.mark, 0);
  }
});

test("several: another scanner's admission comes back as already in, with its record", async () => {
  const a = await admit(input({ claimAtServer: async () => ({ kind: "already-in", record: HOLDER }) }));
  assert.deepEqual(a, { kind: "already-in", record: HOLDER });
});

test("several: a ticket this device already knows is in is not asked about again", async () => {
  const i = input({ known: HOLDER });
  assert.deepEqual(await admit(i), { kind: "already-in", record: HOLDER });
  assert.equal(i.calls.claim, 0);
});

test("several: a second claim while one is in flight is refused, not sent", async () => {
  const i = input({ claimInFlight: true });
  assert.equal((await admit(i)).kind, "cant-confirm");
  assert.equal(i.calls.claim, 0);
});

test("single: admits with no signal, from this device's own set", async () => {
  const i = input({ mode: "single", online: false });
  assert.equal((await admit(i)).kind, "admitted");
  assert.equal(i.calls.mark, 1);
  assert.equal(i.calls.claim, 0, "the only door never needs to ask");

  const again = input({ mode: "single", online: false, markLocally: async () => HOLDER });
  assert.deepEqual(await admit(again), { kind: "already-in", record: HOLDER });
});

test("a dead pass admits nothing, in either mode", async () => {
  for (const mode of ["single", "several"] as const) {
    const i = input({ mode, passDead: "Door pass revoked" });
    assert.deepEqual(await admit(i), { kind: "cant-confirm", message: "Door pass revoked" });
    assert.equal(i.calls.mark + i.calls.claim, 0, `${mode}: nothing consumed or claimed`);
  }
});

test("several: a scanner the server calls outdated admits nobody", async () => {
  const i = input({ claimAtServer: async () => ({ kind: "outdated", message: "This scanner is updating - scan again in a moment" }) });
  const a = await admit(i);
  assert.deepEqual(a, { kind: "cant-confirm", message: "This scanner is updating - scan again in a moment" });
  assert.equal(i.calls.mark, 0);
});

test("a claim answered after the tab moved to another pass never lands in the new event's set", () => {
  const before = new Map<string, CheckinRecord>([["ser-new 1", { ...HOLDER, seriesId: "ser-new", edition: 1 }]]);
  assert.equal(withConfirmed(before, "ser-1 7", HOLDER, "old-pass-token", "new-pass-token"), null);
  assert.equal(withConfirmed(before, "ser-1 7", HOLDER, "old-pass-token", undefined), null, "nor in a tab with no pass now");
  const same = withConfirmed(before, "ser-1 7", HOLDER, "pass-token", "pass-token");
  assert.ok(same && same.get("ser-1 7") === HOLDER && same.size === 2);
  assert.equal(before.size, 1, "a new set; the old one is never edited in place");
});

test("the store records a confirmed answer only through that guard", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/lib/scanner/store.svelte.ts", import.meta.url), "utf8");
  const claim = src.slice(src.indexOf("private async claimAtServer("), src.indexOf("private async mark("));
  assert.match(claim, /withConfirmed\(this\.checkins, db\.ticketKey\(seriesId, edition\), answer\.record, pass\.token, this\.pass\?\.token\)/);
  assert.doesNotMatch(claim, /next\.set\(/, "no second, unguarded write to the set");
});
