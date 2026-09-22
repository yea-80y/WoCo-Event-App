/**
 * Sender pacing (#619) — the gate, the checks, and what survives a restart.
 *
 * Every guard here has a mutation the suite must catch; the ones that are
 * easy to get subtly wrong say so in the test name.
 */

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pacing: typeof import("../src/lib/sender-pacing/index.js");

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-sender-pacing-")));
  pacing = await import("../src/lib/sender-pacing/index.js");
});

beforeEach(() => {
  pacing._resetPacingForTest();
});

const A = "0xaaaa000000000000000000000000000000000001";
const B = "0xbbbb000000000000000000000000000000000002";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-09-22T09:00:00Z");

const hashes = (n: number, p = "h") => Array.from({ length: n }, (_, i) => `${p}${i}`.padEnd(64, "0"));
const never = () => false;

/** Admit a batch at `at`, record every message accepted, return its id. */
function sendBatch(sender: string, n: number, at: number, id = `job:u${at}`): string {
  const r = pacing.admit(sender, id, n, at);
  assert.equal(r.ok, true, `batch at ${new Date(at).toISOString()} was refused: ${JSON.stringify(r)}`);
  pacing.recordAccepted(sender, id, "u", hashes(n, `${id}-`), at);
  return id;
}

describe("the gate", () => {
  test("a first batch of new contacts is 100", () => {
    const r = pacing.admit(A, "j:u1", 5_000, T0);
    assert.deepEqual(r, { ok: true, size: 100, rung: 1 });
  });

  test("the next batch waits a full hour from the last one's start", () => {
    sendBatch(A, 100, T0, "j:u1");
    const early = pacing.admit(A, "j:u2", 100, T0 + 59 * MIN);
    assert.equal(early.ok, false);
    assert.equal(!early.ok && early.code, "TOO_SOON");
    assert.equal(!early.ok && early.retryAt, T0 + HOUR);
    assert.equal(pacing.admit(A, "j:u2", 100, T0 + HOUR).ok, true);
  });

  test("the wait survives a restart", () => {
    sendBatch(A, 100, T0, "j:u1");
    pacing._reloadPacingForTest();
    const r = pacing.admit(A, "j:u2", 100, T0 + 30 * MIN);
    assert.equal(!r.ok && r.code, "TOO_SOON", "a restart must never shorten a wait");
  });

  test("the day ceiling refuses the eleventh rung-1 batch until UTC midnight", () => {
    for (let i = 0; i < 10; i++) sendBatch(A, 100, T0 + i * HOUR, `j:u${i}`);
    const r = pacing.admit(A, "j:u10", 100, T0 + 10 * HOUR);
    assert.equal(!r.ok && r.code, "DAY_EXHAUSTED");
    assert.equal(!r.ok && r.retryAt, Date.parse("2026-09-23T00:00:00Z"));
  });

  test("the next UTC day is one rung up", () => {
    sendBatch(A, 100, T0, "j:u1");
    const r = pacing.admit(A, "j:u2", 5_000, Date.parse("2026-09-23T00:00:00Z"));
    assert.deepEqual(r, { ok: true, size: 300, rung: 2 });
  });

  test("the rung counts sending days, not calendar days — waiting does not skip rungs", () => {
    sendBatch(A, 100, T0, "j:u1");
    const r = pacing.admit(A, "j:u2", 5_000, T0 + 6 * DAY);
    assert.equal(r.ok && r.rung, 2);
  });

  test("the last rung does not end: after seven sending days a batch is still 2,000", () => {
    for (let d = 0; d < 7; d++) sendBatch(A, 100, T0 + d * DAY, `j:u${d}`);
    const r = pacing.admit(A, "j:u8", 50_000, T0 + 8 * DAY);
    assert.deepEqual(r, { ok: true, size: 2_000, rung: 7 });
  });

  test("a batch never exceeds what is left to send", () => {
    assert.equal(pacing.admit(A, "j:u1", 40, T0).ok && pacing.position(A, T0).admittedToday, 40);
  });

  test("two jobs of one sender share the hourly slot and the day", () => {
    sendBatch(A, 100, T0, "one:u1");
    assert.equal(pacing.admit(A, "two:u1", 100, T0 + 5 * MIN).ok, false);
  });

  test("senders are independent", () => {
    sendBatch(A, 100, T0, "j:u1");
    assert.equal(pacing.admit(B, "k:u1", 100, T0 + MIN).ok, true);
  });
});

describe("proof", () => {
  test("a new contact is proven an hour after acceptance, unless it was blocked meanwhile", () => {
    const id = "j:u1";
    pacing.admit(A, id, 3, T0);
    const [a, b, c] = hashes(3, "p");
    pacing.recordAccepted(A, id, "u", [a!, b!, c!], T0);

    pacing.sweepPacing(never, T0 + 10 * MIN);
    assert.equal(pacing.isProven(A, a!), false, "ten minutes is not proof");

    pacing.sweepPacing((h) => h === b, T0 + HOUR);
    assert.equal(pacing.isProven(A, a!), true);
    assert.equal(pacing.isProven(A, b!), false, "a contact that bounced in the hour is not proof");
    assert.equal(pacing.isProven(A, c!), true);
  });

  test("proof is per sender — a contact proven for one organiser is new to another", () => {
    const [h] = hashes(1, "x");
    pacing.admit(A, "j:u1", 1, T0);
    pacing.recordAccepted(A, "j:u1", "u", [h!], T0);
    pacing.sweepPacing(never, T0 + HOUR);
    assert.equal(pacing.isProven(A, h!), true);
    assert.equal(pacing.isProven(B, h!), false);
  });

  test("sends to proven contacts never become proof of anything", () => {
    const [h] = hashes(1, "y");
    pacing.recordAccepted(A, "j:p", "p", [h!], T0);
    pacing.sweepPacing(never, T0 + 2 * HOUR);
    assert.equal(pacing.isProven(A, h!), false);
  });

  test("a re-import keeps proof only for contacts still on the list", () => {
    const [a, b] = hashes(2, "k");
    pacing.admit(A, "j:u1", 2, T0);
    pacing.recordAccepted(A, "j:u1", "u", [a!, b!], T0);
    pacing.sweepPacing(never, T0 + HOUR);
    pacing.pruneProven(A, new Set([a!]));
    assert.equal(pacing.isProven(A, a!), true);
    assert.equal(pacing.isProven(A, b!), false);
  });

  test("erasure forgets proof, and access reports it", () => {
    const [a] = hashes(1, "e");
    pacing.admit(A, "j:u1", 1, T0);
    pacing.recordAccepted(A, "j:u1", "u", [a!], T0);
    assert.deepEqual(pacing.sendersProvenFor(a!), [A], "pending proof is disclosed too");
    pacing.sweepPacing(never, T0 + HOUR);
    assert.equal(pacing.forgetHash(a!), true);
    assert.equal(pacing.isProven(A, a!), false);
    assert.deepEqual(pacing.sendersProvenFor(a!), []);
  });

  test("proof survives a restart", () => {
    const [a] = hashes(1, "r");
    pacing.admit(A, "j:u1", 1, T0);
    pacing.recordAccepted(A, "j:u1", "u", [a!], T0);
    pacing.sweepPacing(never, T0 + HOUR);
    pacing._reloadPacingForTest();
    assert.equal(pacing.isProven(A, a!), true);
  });
});

describe("the checks", () => {
  test("4 hard bounces in 100 new contacts holds new contacts; 3 does not", () => {
    const id = sendBatch(A, 100, T0, "j:u1");
    pacing.recordBounce(A, id, "General", 3, T0 + MIN);
    assert.equal(pacing.pacingState(A, T0 + MIN).kind, "open");
    pacing.recordBounce(A, id, "General", 1, T0 + 2 * MIN);
    const s = pacing.pacingState(A, T0 + 2 * MIN);
    assert.equal(s.kind, "held");
    assert.equal(s.kind === "held" && s.scope, "new", "a bounce hold stops only new contacts");
  });

  test("a hold refuses the next batch but lets proven contacts drain", () => {
    const id = sendBatch(A, 100, T0, "j:u1");
    pacing.recordBounce(A, id, "General", 4, T0 + MIN);
    const r = pacing.admit(A, "j:u2", 100, T0 + HOUR);
    assert.equal(!r.ok && r.code, "HELD");
    assert.equal(pacing.mayDrain(A, "p", T0 + HOUR), true);
    assert.equal(pacing.mayDrain(A, "u", T0 + HOUR), false);
  });

  test("one bounce from a tiny send is noise, not a rate", () => {
    const id = sendBatch(A, 1, T0, "j:u1");
    pacing.recordBounce(A, id, "General", 1, T0 + MIN);
    assert.equal(pacing.pacingState(A, T0 + MIN).kind, "open");
  });

  test("10 hard bounces in 100 stops the sender, and the stop is sticky", () => {
    const id = sendBatch(A, 100, T0, "j:u1");
    pacing.recordBounce(A, id, "General", 10, T0 + MIN);
    assert.equal(pacing.pacingState(A, T0 + MIN).kind, "stopped");
    assert.equal(pacing.pacingState(A, T0 + 30 * DAY).kind, "stopped", "time never lifts a stop");
    assert.equal(pacing.mayDrain(A, "p", T0 + MIN), false);
  });

  test("returning contacts cannot dilute a dead import: the new-contacts check stops it after one batch", () => {
    // The worked example: 5,000 proven + 100 new, 20% of the new ones dead.
    pacing.recordAccepted(A, "j:p", "p", hashes(5_000, "ok"), T0);
    const id = sendBatch(A, 100, T0 + MIN, "j:u1");
    pacing.recordBounce(A, id, "General", 20, T0 + 5 * MIN);
    const w = pacing.pacingWindow(A, T0 + 5 * MIN);
    assert.ok(w.all.bounces / w.all.sends < 0.04, "the all-sends rate alone would say nothing");
    assert.equal(pacing.pacingState(A, T0 + 5 * MIN).kind, "stopped");
  });

  test("a new-contacts hold stands while the all-sends rate is clean", () => {
    pacing.recordAccepted(A, "j:p", "p", hashes(5_000, "ok"), T0);
    const id = sendBatch(A, 100, T0 + MIN, "j:u1");
    pacing.recordBounce(A, id, "General", 4, T0 + 5 * MIN);
    const s = pacing.pacingState(A, T0 + 5 * MIN);
    assert.equal(s.kind === "held" && s.causes.join(), "new-bounce");
  });

  test("complaints: 1 is noise, 2 holds, 5 in 1,000 stops", () => {
    pacing.recordAccepted(A, "j:p", "p", hashes(900, "ok"), T0);
    const id = sendBatch(A, 100, T0, "j:u1");
    pacing.recordComplaint(A, id, { feedbackType: "abuse" }, 1, T0 + MIN);
    assert.equal(pacing.pacingState(A, T0 + MIN).kind, "open");
    pacing.recordComplaint(A, id, { feedbackType: "abuse" }, 1, T0 + 2 * MIN);
    const held = pacing.pacingState(A, T0 + 2 * MIN);
    assert.equal(held.kind === "held" && held.scope, "all", "complaints are about the mail: everything waits");
    assert.equal(pacing.mayDrain(A, "p", T0 + 2 * MIN), false);
    pacing.recordComplaint(A, id, { feedbackType: "abuse" }, 3, T0 + 3 * MIN);
    assert.equal(pacing.pacingState(A, T0 + 3 * MIN).kind, "stopped");
  });

  test("a complaint confined to the new contacts holds only them when the rest is clean", () => {
    pacing.recordAccepted(A, "j:p", "p", hashes(5_000, "ok"), T0);
    const id = sendBatch(A, 100, T0 + MIN, "j:u1");
    pacing.recordComplaint(A, id, { feedbackType: "abuse" }, 2, T0 + 5 * MIN);
    const s = pacing.pacingState(A, T0 + 5 * MIN);
    assert.equal(s.kind === "held" && s.scope, "new");
  });

  test("not-spam and complaints about unsent mail never count", () => {
    const id = sendBatch(A, 100, T0, "j:u1");
    pacing.recordComplaint(A, id, { feedbackType: "not-spam" }, 10, T0 + MIN);
    pacing.recordComplaint(A, id, { feedbackType: "abuse", complaintSubType: "OnAccountSuppressionList" }, 10, T0 + MIN);
    assert.equal(pacing.pacingState(A, T0 + MIN).kind, "open");
    assert.equal(pacing.countsAsComplaint({ feedbackType: "abuse" }), true);
    assert.equal(pacing.countsAsComplaint({}), true, "a complaint without a type still counts");
  });

  test("a suppression-list hard bounce counts against the list", () => {
    const id = sendBatch(A, 100, T0, "j:u1");
    pacing.recordBounce(A, id, "OnAccountSuppressionList", 4, T0 + MIN);
    assert.equal(pacing.pacingState(A, T0 + MIN).kind, "held");
  });

  test("an event for an unknown or aged-out batch is dropped, not guessed", () => {
    sendBatch(A, 100, T0, "j:u1");
    assert.equal(pacing.recordBounce(A, "j:u99", "General", 50, T0 + MIN), false);
    assert.equal(pacing.recordBounce("../../etc", "j:u1", "General", 50, T0 + MIN), false);
    assert.equal(pacing.pacingState(A, T0 + MIN).kind, "open");
  });

  test("a hold lifts on its own once the bad batch leaves the 7-day window", () => {
    const id = sendBatch(A, 100, T0, "j:u1");
    pacing.recordBounce(A, id, "General", 5, T0 + MIN);
    assert.equal(pacing.pacingState(A, T0 + 6 * DAY).kind, "held");
    const seen: string[] = [];
    pacing.onPacingStateChange((s, st) => seen.push(`${s}:${st.kind}`));
    pacing.sweepPacing(never, T0 + 7 * DAY + MIN);
    assert.equal(pacing.pacingState(A, T0 + 7 * DAY + MIN).kind, "open");
    assert.deepEqual(seen, [`${A}:open`]);
  });

  test("only an operator lifts a stop, and the same evidence cannot re-stop the sender", () => {
    const id = sendBatch(A, 100, T0, "j:u1");
    pacing.recordBounce(A, id, "General", 10, T0 + MIN);
    const after = pacing.liftSender(A, "ops:alice", "bounces were suppression-list hits", T0 + HOUR);
    assert.equal(after.kind, "open");
    pacing.recordBounce(A, id, "General", 1, T0 + HOUR + MIN);
    assert.equal(pacing.pacingState(A, T0 + HOUR + MIN).kind, "open");
    const log = pacing.listForOps(T0 + HOUR + MIN).find((s) => s.sender === A)!.log;
    assert.deepEqual(log.map((e) => [e.action, e.by]), [["stop", "automatic"], ["lift", "ops:alice"]]);
  });

  test("a stop found at the gate is saved and announced", () => {
    const id = sendBatch(A, 100, T0, "j:u1");
    const seen: string[] = [];
    pacing.onPacingStateChange((_s, st) => seen.push(st.kind));
    pacing.recordBounce(A, id, "General", 10, T0 + MIN);
    assert.deepEqual(seen, ["stopped"]);
    pacing._reloadPacingForTest();
    assert.equal(pacing.pacingState(A, T0 + 2 * MIN).kind, "stopped", "a stop survives a restart");
  });

  test("a manual stop blocks everything until lifted", () => {
    pacing.stopSender(A, "ops:bob", "investigating", T0);
    assert.equal(!pacing.admit(A, "j:u1", 100, T0).ok && "refused", "refused");
    assert.equal(pacing.mayDrain(A, "p", T0), false);
  });
});

describe("health", () => {
  test("public health reports counts and never a sender id", () => {
    const id = sendBatch(A, 100, T0, "j:u1");
    pacing.recordBounce(A, id, "General", 10, T0 + MIN);
    const h = pacing.pacingHealth(T0 + MIN);
    assert.equal(h.ok, false);
    assert.equal(h.stopped, 1);
    assert.ok(!JSON.stringify(h).includes(A.slice(2, 10)));
  });

  test("a hold alone is reported but is not an alarm", () => {
    const id = sendBatch(A, 100, T0, "j:u1");
    pacing.recordBounce(A, id, "General", 4, T0 + MIN);
    const h = pacing.pacingHealth(T0 + MIN);
    assert.deepEqual(h.held, { new: 1, all: 0 });
    assert.equal(h.stopped, 0);
  });

  test("the platform rate mirrors SES: suppression-list bounces are left out", () => {
    pacing.recordPlatformAccepted(100, T0);
    pacing.recordPlatformBounce("OnAccountSuppressionList", 10, T0);
    assert.equal(pacing.pacingHealth(T0).platform7d.bounceOk, true);
    pacing.recordPlatformBounce("General", 4, T0);
    const h = pacing.pacingHealth(T0);
    assert.equal(h.platform7d.bounceOk, false);
    assert.equal(h.ok, false);
  });

  test("platform totals reach disk on flush", () => {
    pacing.recordPlatformAccepted(7, T0);
    pacing.flushPacing();
    const file = join(process.cwd(), ".data", "sender-pacing", "_platform.json");
    assert.ok(existsSync(file));
    assert.equal(JSON.parse(readFileSync(file, "utf-8"))["2026-09-22"].accepted, 7);
  });
});
