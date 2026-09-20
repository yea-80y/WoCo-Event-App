/**
 * The lap sender against a fake feed (apps/web/src/lib/credits/lap-sender.ts).
 *
 * The fake is a WORLD, not a script: addresses hold bytes, a write to an
 * occupied address is silently kept-as-was (Bee's dedupe), and a reply can be
 * lost AFTER the bytes have landed. That last one is the case this file exists
 * for. It is ordinary on a park's signal, it cannot be produced on demand on a
 * phone, and a sender that handles it wrongly adds the same laps twice to a
 * count that can never be corrected.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ANOTHER_DEVICE, createLapSender, type LapSenderDeps } from "../src/lib/credits/lap-sender.js";
import {
  addTap,
  emptyJournal,
  journalCounts,
  rideDate,
  type CountedLaps,
  type LapJournal,
  type PreparedRide,
} from "../src/lib/credits/lap-journal.js";
import { nextCreditStatement } from "../src/lib/credits/next-statement.js";
import type { CreditHead } from "../src/lib/credits/credits.js";
import { type CreditStatementV1, type Hex0x } from "@woco/shared";

const SUBJECT = `0x${"11".repeat(32)}` as Hex0x;
const HOLDER = "aa".repeat(32);
const T0 = Date.UTC(2026, 8, 21, 10, 0, 0);
const MIN = 60_000;

/** A single banded feed: address -> the JSON that landed there first. */
class World {
  chunks = new Map<string, string>();
  journal: LapJournal = emptyJournal();
  /** Everything that happened, in order — the ordering rules are asserted on it. */
  log: string[] = [];
  /** Replies to drop, AFTER the bytes have landed. */
  dropReplies = 0;
  /** Uploads that never reach the network at all. */
  failUploads = 0;
  unconfirmedNext = false;
  sealFailures = 0;
  sealed: CountedLaps[] = [];
  prepareCalls: number[][] = [];
  retries: number[] = [];
  nonce = 0;
  /** Run once, the moment the next upload starts. */
  duringSend: (() => void) | null = null;

  head(): CreditHead | null {
    let best: CreditHead | null = null;
    for (const [addr, json] of this.chunks) {
      const version = Number(addr);
      const statement = (JSON.parse(json) as { statement: CreditStatementV1 }).statement;
      if (!best || version > best.version) best = { statement, visibility: "private", version, band: 0 };
    }
    return best;
  }

  /** Another device writes the next version first. */
  rivalWrites(laps: number): void {
    const prev = this.head();
    const s = nextCreditStatement({ prev: prev?.statement ?? null, subject: SUBJECT, holder: HOLDER, laps, date: "2026-09-21" });
    const version = (prev?.version ?? -1) + 1;
    this.chunks.set(String(version), JSON.stringify({ box: "rival", statement: { ...s, holderSig: "rival" } }));
  }

  deps(): LapSenderDeps {
    return {
      read: () => structuredClone(this.journal),
      write: (j) => {
        this.journal = structuredClone(j);
        this.log.push(j.prepared ? `saved:prepared(${j.prepared.times.length})` : "saved");
      },
      prepare: async (times, warm) => {
        this.prepareCalls.push([...times]);
        this.log.push(`prepare(${times.length})`);
        const prev = warm ?? this.head();
        const date = rideDate(times);
        if (prev && prev.statement.session.date > date) {
          return { ok: false, kind: "held", heldBefore: prev.statement.session.date };
        }
        const unsigned = nextCreditStatement({ prev: prev?.statement ?? null, subject: SUBJECT, holder: HOLDER, laps: times.length, date });
        // Deterministic over the statement, like ed25519.
        const statement = { ...unsigned, holderSig: `sig:${unsigned.seq}:${unsigned.total}` };
        return {
          ok: true,
          prepared: {
            times: [...times],
            statement,
            visibility: "private",
            band: 0,
            version: prev ? prev.version + 1 : 0,
            // Sealing is randomised: building twice never yields the same bytes.
            body: { box: `nonce-${this.nonce++}`, statement },
            indexed: true,
            rollover: false,
          },
        };
      },
      send: async (p: PreparedRide) => {
        this.log.push("send");
        this.duringSend?.();
        this.duringSend = null;
        if (this.failUploads > 0) {
          this.failUploads -= 1;
          return { ok: false, error: "Failed to fetch" };
        }
        const addr = String(p.version);
        const json = JSON.stringify(p.body);
        if (!this.chunks.has(addr)) this.chunks.set(addr, json);
        if (this.dropReplies > 0) {
          this.dropReplies -= 1;
          return { ok: false, error: "Failed to fetch" };
        }
        const unconfirmed = this.unconfirmedNext;
        this.unconfirmedNext = false;
        const status = unconfirmed ? "unconfirmed" : this.chunks.get(addr) === json ? "verified" : "superseded";
        return {
          ok: true,
          version: p.version as number,
          band: 0,
          settled: Promise.resolve(
            status === "unconfirmed"
              ? { status, version: p.version as number, reason: "not yet readable" }
              : { status, version: p.version as number },
          ),
        };
      },
      reconcile: async () => ({ status: "unavailable" }),
      seal: async (laps) => {
        this.log.push(`seal(${laps.seq})`);
        if (this.sealFailures > 0) {
          this.sealFailures -= 1;
          return false;
        }
        this.sealed.push(structuredClone(laps));
        return true;
      },
      onChange: () => {},
      retryLater: (attempt) => this.retries.push(attempt),
    };
  }

  tap(at: number): void {
    this.journal = addTap(this.journal, at);
  }
}

// ---------------------------------------------------------------------------
// The happy path, and its order
// ---------------------------------------------------------------------------

test("a tap is counted, then its time is sealed", async () => {
  const w = new World();
  const sender = createLapSender(w.deps());
  w.tap(T0);
  await sender.kick();

  assert.equal(w.head()?.statement.total, 1);
  assert.deepEqual(w.journal.waiting, []);
  assert.equal(w.journal.prepared, null);
  assert.deepEqual(w.sealed, [{ seq: 0, total: 1, times: [T0], sealed: false }]);
  assert.equal(journalCounts(w.journal).unsealed, 0);
  assert.equal(sender.head?.statement.total, 1);
  assert.equal(sender.error, null);
});

test("the exact write is SAVED on the phone before any upload starts", async () => {
  const w = new World();
  let savedAtSend: LapJournal | null = null;
  w.duringSend = () => (savedAtSend = structuredClone(w.journal));
  w.tap(T0);
  w.tap(T0 + 3 * MIN);
  await createLapSender(w.deps()).kick();

  const seen = savedAtSend as LapJournal | null;
  assert.ok(seen, "an upload happened");
  assert.deepEqual(seen.prepared?.times, [T0, T0 + 3 * MIN], "the taps were already bound to the write");
  assert.deepEqual(seen.waiting, [], "and no longer free to be built into a second one");
  assert.ok(w.log.indexOf("saved:prepared(2)") < w.log.indexOf("send"));
});

test("sealing comes after the lap, never before it", async () => {
  const w = new World();
  w.tap(T0);
  await createLapSender(w.deps()).kick();
  assert.ok(w.log.indexOf("send") < w.log.indexOf("seal(0)"));
});

// ---------------------------------------------------------------------------
// The lost reply
// ---------------------------------------------------------------------------

test("a lap whose upload LANDED but whose reply was lost is counted ONCE", async () => {
  const w = new World();
  const sender = createLapSender(w.deps());
  w.tap(T0);
  w.dropReplies = 1;
  await sender.kick();

  // The phone believes it failed. The network holds the lap.
  assert.equal(w.head()?.statement.total, 1);
  assert.equal(journalCounts(w.journal).waiting, 1);
  assert.equal(w.journal.prepared?.attempted, true);
  assert.deepEqual(w.retries, [1]);

  await sender.kick();

  assert.equal(w.head()?.statement.total, 1, "ONE lap — a rebuilt statement would have made this 2");
  assert.equal(w.chunks.size, 1, "and one write, not two");
  assert.deepEqual(w.prepareCalls, [[T0]], "the retry re-sent the saved write; it never built another");
  assert.equal(journalCounts(w.journal).waiting, 0);
  assert.deepEqual(w.sealed.map((s) => s.times), [[T0]]);
});

test("a retry survives a reload: a fresh sender replays what the journal holds", async () => {
  const w = new World();
  w.tap(T0);
  w.dropReplies = 1;
  await createLapSender(w.deps()).kick();

  // New page, new sender, no warm head — only the stored journal.
  const reloaded = createLapSender(w.deps());
  await reloaded.kick();

  assert.equal(w.head()?.statement.total, 1);
  assert.deepEqual(w.prepareCalls, [[T0]]);
  assert.equal(reloaded.head?.statement.total, 1);
});

test("taps made while a write is in doubt wait behind it, then go as one group", async () => {
  const w = new World();
  const sender = createLapSender(w.deps());
  w.tap(T0);
  w.failUploads = 1;
  await sender.kick();
  w.tap(T0 + 3 * MIN);
  w.tap(T0 + 6 * MIN);
  await sender.kick();

  assert.equal(w.head()?.statement.total, 3);
  assert.deepEqual(w.prepareCalls, [[T0], [T0 + 3 * MIN, T0 + 6 * MIN]]);
  assert.deepEqual(w.sealed.map((s) => s.times), [[T0], [T0 + 3 * MIN, T0 + 6 * MIN]]);
});

// ---------------------------------------------------------------------------
// A day without signal
// ---------------------------------------------------------------------------

test("a whole day offline goes up as ONE statement carrying every tap's own time", async () => {
  const w = new World();
  const day = Array.from({ length: 130 }, (_, i) => T0 + i * 3 * MIN);
  for (const at of day) w.tap(at);
  await createLapSender(w.deps()).kick();

  assert.equal(w.chunks.size, 1);
  assert.equal(w.head()?.statement.total, 130);
  assert.deepEqual(w.head()?.statement.session, { date: "2026-09-21", count: 130 });
  assert.deepEqual(w.sealed[0]?.times, day);
});

test("laps from two days go oldest first, each under its own date", async () => {
  const w = new World();
  const monday = Date.UTC(2026, 8, 21, 16, 0, 0);
  const tuesday = Date.UTC(2026, 8, 22, 9, 0, 0);
  w.tap(tuesday);
  w.tap(monday);
  await createLapSender(w.deps()).kick();

  assert.deepEqual(w.prepareCalls, [[monday], [tuesday]]);
  assert.deepEqual(w.head()?.statement.session, { date: "2026-09-22", count: 1 });
  assert.equal(w.head()?.statement.total, 2);
});

test("a tap made DURING an upload is picked up by the same run", async () => {
  const w = new World();
  w.tap(T0);
  w.duringSend = () => w.tap(T0 + 3 * MIN);
  await createLapSender(w.deps()).kick();

  assert.equal(w.head()?.statement.total, 2);
  assert.deepEqual(w.journal.waiting, []);
});

// ---------------------------------------------------------------------------
// Another device
// ---------------------------------------------------------------------------

test("losing a race rebuilds the laps on the WINNER's head, with their original times", async () => {
  const w = new World();
  const sender = createLapSender(w.deps());
  w.tap(T0);
  await sender.kick();
  assert.equal(sender.head?.statement.total, 1);

  w.rivalWrites(5); // the sender's warm head is now stale
  w.tap(T0 + 3 * MIN);
  await sender.kick();

  assert.equal(w.head()?.statement.total, 7, "1 + the rival's 5 + this lap");
  assert.deepEqual(w.sealed.map((s) => s.times), [[T0], [T0 + 3 * MIN]]);
  assert.equal(sender.error, null);
});

test("losing twice in a row tells the rider, and keeps the laps", async () => {
  const w = new World();
  const deps = w.deps();
  const send = deps.send;
  // Every upload finds a rival already at its address.
  deps.send = async (p) => {
    w.chunks.set(String(p.version), JSON.stringify({ box: "rival", statement: p.statement }));
    return send(p);
  };
  const sender = createLapSender(deps);
  w.tap(T0);
  await sender.kick();

  assert.equal(sender.error, ANOTHER_DEVICE);
  assert.deepEqual(w.journal.waiting, [T0], "not counted, and not lost");
  assert.equal(w.journal.prepared, null);
  assert.equal(sender.head, null, "and the next attempt reads everything fresh");
});

test("laps older than a newer head are held, not signed", async () => {
  const w = new World();
  const tuesday = Date.UTC(2026, 8, 22, 9, 0, 0);
  w.tap(tuesday);
  await createLapSender(w.deps()).kick();

  const monday = Date.UTC(2026, 8, 21, 16, 0, 0);
  w.tap(monday);
  const sender = createLapSender(w.deps());
  await sender.kick();

  assert.equal(w.head()?.statement.total, 1, "no statement was written for the held lap");
  assert.equal(w.journal.heldBefore, "2026-09-22");
  assert.deepEqual(journalCounts(w.journal), { waiting: 1, held: 1, unsealed: 0 });
});

// ---------------------------------------------------------------------------
// Things that are not failures
// ---------------------------------------------------------------------------

test("an unconfirmed read-back is a saved lap with a note, not an error", async () => {
  const w = new World();
  const sender = createLapSender(w.deps());
  w.tap(T0);
  w.unconfirmedNext = true;
  await sender.kick();

  assert.equal(journalCounts(w.journal).waiting, 0);
  assert.equal(sender.error, null);
  assert.match(sender.notice ?? "", /settling/);
  assert.equal(w.sealed.length, 1);
});

test("times that cannot be sealed yet never fail or block a lap", async () => {
  const w = new World();
  const sender = createLapSender(w.deps());
  w.tap(T0);
  w.sealFailures = 1;
  await sender.kick();

  assert.equal(w.head()?.statement.total, 1, "the lap is counted");
  assert.equal(sender.error, null, "and nothing is reported as failed");
  assert.equal(journalCounts(w.journal).unsealed, 1, "the time is kept on the phone");
  assert.deepEqual(w.retries, [1]);

  w.tap(T0 + 3 * MIN);
  await sender.kick();

  assert.equal(w.head()?.statement.total, 2, "the next lap went first");
  assert.equal(journalCounts(w.journal).unsealed, 0);
  assert.deepEqual(w.sealed.map((s) => s.seq), [0, 1]);
});

test("times that can NEVER be sealed still never block a lap", async () => {
  const w = new World();
  const sender = createLapSender(w.deps());
  w.sealFailures = 99;
  w.tap(T0);
  await sender.kick();
  const mark = w.log.length;
  w.tap(T0 + 3 * MIN);
  await sender.kick();

  assert.equal(w.head()?.statement.total, 2, "the second lap went up past the stuck seal");
  const second = w.log.slice(mark);
  assert.ok(second.indexOf("send") >= 0 && second.indexOf("send") < second.indexOf("seal(0)"), "laps first, times after");
  assert.equal(sender.error, null);
  assert.equal(journalCounts(w.journal).unsealed, 2, "both laps' times are still on the phone");
});

test("a stale read cannot replace a newer head the sender wrote", async () => {
  const w = new World();
  const sender = createLapSender(w.deps());
  w.tap(T0);
  await sender.kick();
  const older = structuredClone(sender.head) as CreditHead;
  w.tap(T0 + 3 * MIN);
  await sender.kick();
  assert.equal(sender.head?.statement.seq, 1);

  sender.offerHead(older); // a read that started before the second lap landed
  assert.equal(sender.head?.statement.seq, 1);

  w.tap(T0 + 6 * MIN);
  await sender.kick();
  assert.equal(w.head()?.statement.total, 3);
  assert.equal(w.chunks.size, 3, "no collision, no rebuild");
});

test("a newer read is taken", async () => {
  const w = new World();
  const sender = createLapSender(w.deps());
  w.tap(T0);
  await sender.kick();
  w.rivalWrites(4);
  sender.offerHead(w.head());
  assert.equal(sender.head?.statement.total, 5);
});

test("the retry ladder climbs while sending fails, and resets when the network returns", async () => {
  const w = new World();
  const sender = createLapSender(w.deps());
  w.failUploads = 99;
  w.tap(T0);
  await sender.kick();
  await sender.kick();
  await sender.kick();
  // Each failed run is scheduled further out than the last — which is right
  // while nothing has changed, and wrong the moment signal comes back.
  assert.deepEqual(w.retries, [1, 2, 3]);

  sender.resetBackoff();
  await sender.kick();
  assert.deepEqual(w.retries, [1, 2, 3, 1], "the next try is at the SHORTEST delay, not the longest");
});

test("a reset does not disturb the laps themselves", async () => {
  const w = new World();
  const sender = createLapSender(w.deps());
  w.failUploads = 1;
  w.tap(T0);
  await sender.kick();
  const before = structuredClone(w.journal);
  sender.resetBackoff();
  assert.deepEqual(w.journal, before);

  await sender.kick();
  assert.equal(w.head()?.statement.total, 1);
  assert.deepEqual(w.prepareCalls, [[T0]], "still the same prepared write, replayed");
});

test("a read the caller made cannot overrule a write that is still in doubt", async () => {
  const w = new World();
  const sender = createLapSender(w.deps());
  w.tap(T0);
  w.failUploads = 1;
  await sender.kick();

  const stale: CreditHead = {
    statement: { ...(w.journal.prepared as PreparedRide).statement, total: 99 },
    visibility: "private", version: 50, band: 0,
  };
  sender.offerHead(stale);
  assert.equal(sender.head, null);
});

// ---------------------------------------------------------------------------
// A first lap, which has no address to replay at
// ---------------------------------------------------------------------------

function firstLapWorld(reconcile: LapSenderDeps["reconcile"]) {
  const w = new World();
  const deps = w.deps();
  const prepare = deps.prepare;
  deps.prepare = async (times, warm) => {
    const r = await prepare(times, warm);
    return r.ok && w.chunks.size === 0 ? { ok: true, prepared: { ...r.prepared, version: null } } : r;
  };
  const send = deps.send;
  // A probing write finds its own version; here that is always 0.
  deps.send = (p) => send({ ...p, version: p.version ?? 0 });
  deps.reconcile = reconcile;
  return { w, deps };
}

test("a first lap that landed with its reply lost is recognised, not re-sent", async () => {
  const { w, deps } = firstLapWorld(async () => ({ status: "landed", version: 0, band: 0 }));
  const sender = createLapSender(deps);
  w.tap(T0);
  w.dropReplies = 1;
  await sender.kick();
  await sender.kick();

  assert.equal(w.head()?.statement.total, 1);
  assert.equal(w.log.filter((l) => l === "send").length, 1, "read, not re-sent");
  assert.equal(journalCounts(w.journal).waiting, 0);
  assert.equal(sender.head?.version, 0);
});

test("a first lap that never landed is sent again", async () => {
  const { w, deps } = firstLapWorld(async () => ({ status: "absent" }));
  const sender = createLapSender(deps);
  w.tap(T0);
  w.failUploads = 1;
  await sender.kick();
  await sender.kick();

  assert.equal(w.head()?.statement.total, 1);
  assert.equal(w.log.filter((l) => l === "send").length, 2);
});

test("a first lap beaten by another device is rebuilt on that device's head", async () => {
  const { w, deps } = firstLapWorld(async () => ({ status: "different" }));
  const sender = createLapSender(deps);
  w.tap(T0);
  w.failUploads = 1;
  await sender.kick();
  w.rivalWrites(4);
  await sender.kick();

  assert.equal(w.head()?.statement.total, 5);
});

test("a first lap that cannot be checked yet stays exactly as it was", async () => {
  const { w, deps } = firstLapWorld(async () => ({ status: "unavailable" }));
  const sender = createLapSender(deps);
  w.tap(T0);
  w.failUploads = 1;
  await sender.kick();
  const before = structuredClone(w.journal);
  await sender.kick();

  assert.deepEqual(w.journal, before);
  assert.equal(w.log.filter((l) => l === "send").length, 1);
});
