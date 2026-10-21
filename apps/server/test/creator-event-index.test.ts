/**
 * The creator event index (`woco/event/creator/{addr}`), #942: a new organiser's
 * FIRST event could be missing from it for good.
 *
 * Same mechanism as the site directory (#944): bee 2.8's one-minute skip list
 * makes a never-written index's strict read error ("lookup at failed", /chunks
 * 500), and the reads before the first event - the attendee gate, the escrow
 * trust check, the dashboard - are what put its index-0 chunk on that list. The
 * fire-and-forget add refused to write (rightly) and the entry was dropped.
 *
 * Pinned here against the shared fake bee (real signed SOCs, production error
 * shapes):
 *  - the add retries past the window and lands; an unreadable index is never
 *    written as empty;
 *  - add, patch and remove share one ordered queue: add then remove ends
 *    removed, remove then re-add ends present, a patch never moves an entry;
 *  - a delete's removal answers after one attempt and the retry completes;
 *  - the display read memoizes a definite absent for 60 s, never an error, and
 *    never "absent" for an index this server wrote; a write clears it;
 *  - none of that can loosen the gate or the trust check: [] is their
 *    restrictive answer, and the memo can only hold it for a creator with no
 *    index bee or this server knows of;
 *  - a dropped change turns `/api/health` `directoryWrites.eventIndex` red;
 *  - page 0 is written last (the commit point), and a page 0 claiming an
 *    overflow page that is missing is never rewritten from what was read.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import type { EventDirectoryEntry, EventFeed, Hex0x, Hex64 } from "@woco/shared";
import { startFakeBee, type FakeBee } from "./helpers/fake-bee.js";

const DEAD = "http://127.0.0.1:9";
const KEY = Wallet.createRandom().privateKey;
const OWNER = new Wallet(KEY).address.slice(2).toLowerCase();

let bee: FakeBee;
let dir: string;
let originalCwd: string;
let feeds: typeof import("../src/lib/swarm/feeds.js");
let events: typeof import("../src/lib/event/service.js");
let topics: typeof import("../src/lib/swarm/topics.js");
let gate: typeof import("../src/lib/gate/check.js");
let retry: typeof import("../src/lib/swarm/first-write-retry.js");
let memoHooks: typeof import("../src/lib/swarm/display-read-memo.js").__displayReadMemoTestHooks;
let alarmGate: typeof import("../src/lib/health/alarm-gate.js").alarmGate;

const sleeps: number[] = [];
let onSleep: ((ms: number) => void | Promise<void>) | null = null;

before(async () => {
  bee = await startFakeBee();
  process.env.BEE_URL = bee.url;
  process.env.PROXY_URL = DEAD;
  process.env.ETHERNA_GATEWAY_URL = DEAD;
  process.env.ETHERNA_TOKEN_ENDPOINT = `${DEAD}/token`;
  process.env.FEED_PRIVATE_KEY = KEY;
  process.env.POSTAGE_BATCH_ID = "aa".repeat(32);
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "woco-creator-index-"));
  process.chdir(dir);
  mkdirSync(join(dir, ".data"));

  feeds = await import("../src/lib/swarm/feeds.js");
  events = await import("../src/lib/event/service.js");
  topics = await import("../src/lib/swarm/topics.js");
  gate = await import("../src/lib/gate/check.js");
  retry = await import("../src/lib/swarm/first-write-retry.js");
  ({ __displayReadMemoTestHooks: memoHooks } = await import("../src/lib/swarm/display-read-memo.js"));
  ({ alarmGate } = await import("../src/lib/health/alarm-gate.js"));
  feeds.__feedWriteTestHooks.setBaseBackoffMs(0);
  retry.__firstWriteRetryTestHooks.setSleep(async (ms) => {
    sleeps.push(ms);
    await onSleep?.(ms);
  });
});

after(async () => {
  retry.__firstWriteRetryTestHooks.setSleep(null);
  await bee.close();
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  bee.reset();
  sleeps.length = 0;
  onSleep = null;
  feeds.__feedWriteTestHooks.clearCache();
  feeds.__feedWriteTestHooks.setClock(null);
  memoHooks.setClock(null);
});

const newCreator = () => Wallet.createRandom().address.toLowerCase() as Hex0x;
const indexTopicHex = (creator: string, page = 0) =>
  topics.topicCreatorDirectory(creator, page).toHex().replace(/^0x/, "").toLowerCase();

/** Every update written to page 0 of the creator's index, oldest first. */
function indexWrites(creator: string): EventDirectoryEntry[][] {
  return bee
    .payloads(OWNER, indexTopicHex(creator))
    .map((p) => feeds.decodeJsonFeed<{ entries: EventDirectoryEntry[] }>(p)!.entries);
}
const latestIds = (creator: string) => indexWrites(creator).at(-1)?.map((e) => e.eventId);
const skip = (creator: string, on: boolean) => bee.skipTopic(OWNER, indexTopicHex(creator), on);

const DAY = 24 * 60 * 60_000;
function entry(creator: Hex0x, eventId: string, extra: Partial<EventDirectoryEntry> = {}): EventDirectoryEntry {
  const start = new Date(Date.now() + 30 * DAY).toISOString();
  return {
    eventId,
    title: `Event ${eventId}`,
    imageHash: "11".repeat(32) as Hex64,
    startDate: start,
    endDate: start,
    location: "Somewhere",
    creatorAddress: creator,
    seriesCount: 1,
    totalTickets: 10,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}
/** An event that ended two days ago: makes its organiser "trusted" (escrow not forced). */
const completed = (creator: Hex0x, eventId: string) => {
  const past = new Date(Date.now() - 2 * DAY).toISOString();
  return entry(creator, eventId, { startDate: past, endDate: past });
};

/** ~930 bytes compacted: four fill page 0, a fifth spills onto page 1. */
const big = (creator: Hex0x, id: string) => entry(creator, id, { title: "T".repeat(600) });

/** The gate rule with only the events branch able to unlock. */
const organiserGate = (creator: string) =>
  gate.checkAttendeeGate(creator, {
    bindingCount: () => 0,
    creatorEvents: (p) => events.getCreatorEvents(p),
    stripeVerified: () => false,
    referralUnlock: async () => "none",
    enforced: () => true,
  });

// ---------------------------------------------------------------------------
// The first event
// ---------------------------------------------------------------------------

test("THE BUG: a new organiser's first event, index skip-listed -> retried past the window, written once with the entry", async () => {
  const creator = newCreator();
  const e = entry(creator, "evt-first-1", { creatorFeedSigner: ("0x" + "ab".repeat(20)) as Hex0x });
  skip(creator, true);
  onSleep = () => skip(creator, false); // the minute passes
  await events.addEventToDirectory(e);
  assert.deepEqual(sleeps, [70_000]);
  assert.deepEqual(indexWrites(creator), [[e]], "exactly one write, holding the entry");
  assert.deepEqual(await events.getCreatorEvents(creator), [e]);
});

test("the gate, trust and dashboard reads before the first event cost bee ONE index lookup per 60 s, and the add still lands", async () => {
  const creator = newCreator();
  let now = 7_000_000;
  memoHooks.setClock(() => now);
  const t = indexTopicHex(creator);

  assert.deepEqual(await events.getCreatorEvents(creator), []);
  assert.equal((await organiserGate(creator)).gated, false);
  assert.equal(await events.isOrganiserTrusted(creator), false);
  now += 60_000 - 1;
  assert.deepEqual(await events.getCreatorEvents(creator), []);
  assert.equal(bee.lookupsOf(t), 1, "absent memoized: the chunk is missed once, not once per read");
  now += 1;
  await events.getCreatorEvents(creator);
  assert.equal(bee.lookupsOf(t), 2, "and for 60 s only");

  const e = completed(creator, "evt-after-reads");
  await events.addEventToDirectory(e);
  assert.deepEqual(await events.getCreatorEvents(creator), [e], "the write clears the memoized absent at once");
  assert.equal((await organiserGate(creator)).gated, true);
  assert.equal(await events.isOrganiserTrusted(creator), true);
});

test("the read says absent but the write's own index-0 probe fails: retried, not dropped", async () => {
  const creator = newCreator();
  const e = entry(creator, "evt-probe-1");
  let probes = 0;
  // The lookup answers "no update found"; only the chunk reads (the write's probe) fail.
  bee.net.chunks500 = true;
  onSleep = () => {
    probes++;
    bee.net.chunks500 = false;
  };
  await events.addEventToDirectory(e);
  assert.equal(probes, 1);
  assert.deepEqual(indexWrites(creator), [[e]]);
});

test("an existing index that cannot be read is never written as empty - the other events survive", async () => {
  const creator = newCreator();
  let clock = 1_000_000;
  feeds.__feedWriteTestHooks.setClock(() => clock);
  const a = entry(creator, "evt-old-1");
  await events.addEventToDirectory(a);
  clock += feeds.READ_YOUR_WRITES_MS + 1; // only bee can answer now - and it cannot
  skip(creator, true);
  onSleep = () => {
    assert.equal(indexWrites(creator).length, 1, "nothing written while the index is unreadable");
    skip(creator, false);
  };
  const b = entry(creator, "evt-new-1");
  await events.addEventToDirectory(b);
  assert.deepEqual(sleeps, [70_000]);
  assert.deepEqual(latestIds(creator), [b.eventId, a.eventId]);
});

test("the write path never reads the display memo: an index written behind a memoized absent is the base of the next add", async () => {
  const creator = newCreator();
  assert.deepEqual(await events.getCreatorEvents(creator), []); // absent, memoized
  const x = entry(creator, "evt-behind-1");
  await feeds.writeFeedPage(
    topics.topicCreatorDirectory(creator),
    feeds.encodeJsonFeed({ v: 1, entries: [x], updatedAt: new Date().toISOString(), pages: 0 }),
  );
  const e = entry(creator, "evt-on-top-1");
  await events.addEventToDirectory(e);
  assert.deepEqual(latestIds(creator), [e.eventId, x.eventId]);
});

// ---------------------------------------------------------------------------
// Add, patch, remove: one ordered queue
// ---------------------------------------------------------------------------

test("add then remove of the same event while the add retries: ends REMOVED, other events untouched", { timeout: 20_000 }, async (t) => {
  t.mock.method(console, "warn", () => {});
  const creator = newCreator();
  let clock = 3_000_000;
  feeds.__feedWriteTestHooks.setClock(() => clock);
  const keep = entry(creator, "evt-keep-1");
  await events.addEventToDirectory(keep);
  clock += feeds.READ_YOUR_WRITES_MS + 1;
  skip(creator, true);
  const doomed = entry(creator, "evt-doomed-1");
  let removed: Promise<void> | undefined;
  onSleep = () => {
    removed = events.__creatorIndexTestHooks.remove(creator, doomed.eventId, creator);
    skip(creator, false);
  };
  await events.addEventToDirectory(doomed);
  await removed;
  assert.deepEqual(latestIds(creator), [keep.eventId]);
  assert.equal(indexWrites(creator).length, 2, "the add and the remove were ONE write");
});

test("remove then re-add of the same event: ends PRESENT", { timeout: 20_000 }, async (t) => {
  t.mock.method(console, "warn", () => {});
  const creator = newCreator();
  let clock = 4_000_000;
  feeds.__feedWriteTestHooks.setClock(() => clock);
  const e = entry(creator, "evt-back-1");
  await events.addEventToDirectory(e);
  clock += feeds.READ_YOUR_WRITES_MS + 1;
  skip(creator, true);
  let readded: Promise<void> | undefined;
  onSleep = () => {
    readded = events.addEventToDirectory(e);
    skip(creator, false);
  };
  await events.__creatorIndexTestHooks.remove(creator, e.eventId, creator); // "retrying"
  await readded;
  assert.deepEqual(sleeps, [70_000]);
  assert.deepEqual(latestIds(creator), [e.eventId]);
  assert.equal(indexWrites(creator).length, 2, "the remove and the re-add were ONE write");
});

test("adds and a patch land in arrival order: newest first, the patch edits in place and never moves the entry", async () => {
  const creator = newCreator();
  const e1 = entry(creator, "evt-order-1");
  const e2 = entry(creator, "evt-order-2");
  skip(creator, true);
  let patched: Promise<void> | undefined;
  onSleep = () => {
    patched = events.__creatorIndexTestHooks.patch({ ...e1, title: "Renamed", description: "" } as unknown as EventFeed, creator);
    skip(creator, false);
  };
  const first = events.addEventToDirectory(e1);
  const second = events.addEventToDirectory(e2);
  await Promise.all([first, second]);
  await patched;
  const latest = indexWrites(creator).at(-1)!;
  assert.deepEqual(latest.map((x) => x.eventId), [e2.eventId, e1.eventId]);
  assert.equal(latest[1]!.title, "Renamed");
  assert.equal(indexWrites(creator).length, 1, "all three in one write");
});

test("a patch or remove from another account is ignored at the write boundary", async () => {
  const creator = newCreator();
  const e = entry(creator, "evt-owned-1");
  await events.addEventToDirectory(e);
  const intruder = newCreator();
  await events.__creatorIndexTestHooks.patch({ ...e, title: "Hijacked" } as unknown as EventFeed, intruder);
  await events.__creatorIndexTestHooks.remove(creator, e.eventId, intruder);
  assert.deepEqual(indexWrites(creator).at(-1), [e]);
  assert.equal(indexWrites(creator).length, 1, "nothing to write, nothing written");
});

test("a delete's removal answers after ONE attempt ('retrying', mid-wait) and the retry still removes it", { timeout: 20_000 }, async (t) => {
  t.mock.method(console, "warn", () => {});
  const creator = newCreator();
  let clock = 5_000_000;
  feeds.__feedWriteTestHooks.setClock(() => clock);
  const e = entry(creator, "evt-delete-1");
  await events.addEventToDirectory(e);
  clock += feeds.READ_YOUR_WRITES_MS + 1;
  skip(creator, true);
  let release!: () => void;
  const minute = new Promise<void>((r) => (release = r));
  onSleep = () => minute;
  await events.__creatorIndexTestHooks.remove(creator, e.eventId, creator);
  assert.deepEqual(sleeps, [70_000], "answered while the retry waits");
  assert.equal(indexWrites(creator).length, 1, "not yet removed");
  skip(creator, false);
  release();
  while (indexWrites(creator).length < 2) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(indexWrites(creator).at(-1), []);
});

// ---------------------------------------------------------------------------
// The display memo never loosens a gate or a trust decision
// ---------------------------------------------------------------------------

test("an unreadable index reads as no events - gate locked, not trusted - and is never memoized", async () => {
  const creator = newCreator();
  skip(creator, true);
  assert.deepEqual(await events.getCreatorEvents(creator), []);
  assert.equal((await organiserGate(creator)).gated, false, "a read that cannot answer refuses");
  skip(creator, false);
  const e = completed(creator, "evt-unskipped");
  // Written behind the memo's back (no queue, so nothing invalidates it).
  await feeds.writeFeedPage(
    topics.topicCreatorDirectory(creator),
    feeds.encodeJsonFeed({ v: 1, entries: [e], updatedAt: new Date().toISOString(), pages: 0 }),
  );
  assert.deepEqual(await events.getCreatorEvents(creator), [e], "the error was not memoized as absent");
  assert.equal((await organiserGate(creator)).gated, true);
  assert.equal(await events.isOrganiserTrusted(creator), true);
});

test("bee's 'no update found' for an index THIS server wrote is not memoized as absent: the events show the moment bee catches up", async () => {
  const creator = newCreator();
  let clock = 6_000_000;
  feeds.__feedWriteTestHooks.setClock(() => clock);
  const e = completed(creator, "evt-lagged-1");
  await events.addEventToDirectory(e);
  clock += feeds.READ_YOUR_WRITES_MS + 1;
  bee.lagTopic(OWNER, indexTopicHex(creator), true);
  const reads = bee.net.chunkReads;
  const lookups = bee.lookupsOf(indexTopicHex(creator));

  assert.deepEqual(await events.getCreatorEvents(creator), [], "display shows what bee shows");
  assert.equal(await events.isOrganiserTrusted(creator), false, "restrictive while bee lags");
  assert.equal(bee.lookupsOf(indexTopicHex(creator)), lookups + 2, "re-asked each time: not memoized");
  assert.equal(bee.net.chunkReads, reads, "a display read never asks the destination");

  bee.lagTopic(OWNER, indexTopicHex(creator), false);
  assert.deepEqual(await events.getCreatorEvents(creator), [e]);
  assert.equal(await events.isOrganiserTrusted(creator), true);
  assert.equal((await organiserGate(creator)).gated, true);
});

// ---------------------------------------------------------------------------
// Give-up and health
// ---------------------------------------------------------------------------

test("every attempt fails: nothing written, one DROPPED line carrying the whole entry, and directoryWrites.eventIndex goes red", async (t) => {
  const creator = newCreator();
  const e = entry(creator, "evt-never-1");
  const errors = t.mock.method(console, "error", () => {});
  const warns = t.mock.method(console, "warn", () => {});
  const before = retry.firstWriteRetryHealth().eventIndex!;
  skip(creator, true);
  await assert.rejects(events.addEventToDirectory(e));
  assert.deepEqual(sleeps, [70_000, 140_000]);
  assert.deepEqual(indexWrites(creator), []);
  const payload = JSON.stringify({ creator, kind: "add", entry: e });
  const dropped = errors.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.includes("[event] Creator index"));
  assert.equal(dropped.length, 1);
  assert.ok(dropped[0]!.includes(payload), dropped[0]);
  const retries = warns.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.includes("[event] Creator index"));
  assert.equal(retries.length, 2);
  for (const l of retries) assert.ok(l.includes(payload), "every retry warning carries the replay payload");

  const health = retry.firstWriteRetryHealth();
  assert.deepEqual(health.eventIndex, { ok: false, pending: 0, retrying: 0, dropped: before.dropped + 1 });
  const verdict = alarmGate({ directoryWrites: health }, "directoryWrites");
  assert.equal(verdict.status, 503);
  assert.deepEqual((verdict.body as { red: string[] }).red, ["directoryWrites.eventIndex"]);
});

test("an overflow page that cannot be read is never dropped: the add waits for it", async (t) => {
  t.mock.method(console, "warn", () => {});
  const creator = newCreator();
  let clock = 9_000_000;
  feeds.__feedWriteTestHooks.setClock(() => clock);
  const five = [1, 2, 3, 4, 5].map((i) => big(creator, `evt-two-pages-${i}`));
  await Promise.all(five.map((e) => events.addEventToDirectory(e)));
  assert.equal(feeds.decodeJsonFeed<{ pages: number }>(bee.payloads(OWNER, indexTopicHex(creator)).at(-1)!)!.pages, 1);
  clock += feeds.READ_YOUR_WRITES_MS + 1;
  const page1 = indexTopicHex(creator, 1);
  bee.skipTopic(OWNER, page1, true);
  const writesBefore = indexWrites(creator).length;
  onSleep = () => {
    assert.equal(indexWrites(creator).length, writesBefore, "nothing written without page 1");
    bee.skipTopic(OWNER, page1, false);
  };
  await events.addEventToDirectory(entry(creator, "evt-two-pages-6"));
  assert.deepEqual(sleeps, [70_000]);
  assert.equal((await events.getCreatorEvents(creator)).length, 6);
});

// ---------------------------------------------------------------------------
// More than one page: page 0 commits
// ---------------------------------------------------------------------------

test("growing onto page 1: a failed page-1 write leaves page 0 as it was, and the retry writes page 1 BEFORE page 0", async (t) => {
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "log", () => {});
  const creator = newCreator();
  const four = [1, 2, 3, 4].map((i) => big(creator, `evt-big-${i}`));
  await Promise.all(four.map((e) => events.addEventToDirectory(e))); // one round, one write
  assert.equal(indexWrites(creator).length, 1);
  assert.equal(feeds.decodeJsonFeed<{ pages: number }>(bee.payloads(OWNER, indexTopicHex(creator))[0]!)!.pages, 0, "one page before the fifth");
  const page1 = indexTopicHex(creator, 1);
  bee.uploadFails(OWNER, page1, true);
  onSleep = () => {
    assert.equal(indexWrites(creator).length, 1, "page 0 untouched: it never claims a page that failed");
    bee.uploadFails(OWNER, page1, false);
    bee.posted.length = 0;
  };
  const fifth = big(creator, "evt-big-5");
  await events.addEventToDirectory(fifth);
  assert.deepEqual(sleeps, [70_000]);

  const page0 = feeds.decodeJsonFeed<{ entries: EventDirectoryEntry[]; pages: number }>(bee.payloads(OWNER, indexTopicHex(creator)).at(-1)!)!;
  assert.equal(page0.pages, 1);
  const overflow = bee.payloads(OWNER, page1).map((p) => feeds.decodeJsonFeed<{ entries: EventDirectoryEntry[] }>(p)!.entries);
  assert.equal(overflow.length, 1);
  assert.deepEqual([...page0.entries, ...overflow[0]!].map((e) => e.eventId), ["evt-big-5", "evt-big-4", "evt-big-3", "evt-big-2", "evt-big-1"]);
  const { socAddress } = await import("./helpers/fake-bee.js");
  assert.deepEqual(bee.posted, [socAddress(OWNER, page1, 0n), socAddress(OWNER, indexTopicHex(creator), 1n)], "page 1, then page 0");
  assert.equal((await events.getCreatorEvents(creator)).length, 5);
});

test("a page 0 claiming an overflow page that is MISSING (an older writer's torn write) is never rewritten from what was read", async (t) => {
  t.mock.method(console, "warn", () => {});
  const errors = t.mock.method(console, "error", () => {});
  const creator = newCreator();
  const a = entry(creator, "evt-torn-1");
  await feeds.writeFeedPage(
    topics.topicCreatorDirectory(creator),
    feeds.encodeJsonFeed({ v: 1, entries: [a], updatedAt: new Date().toISOString(), pages: 1 }),
  );
  await assert.rejects(events.addEventToDirectory(entry(creator, "evt-torn-2")), /overflow page 1 of 1 missing/);
  assert.equal(indexWrites(creator).length, 1, "page 0 never rewritten without page 1's entries");
  assert.equal(bee.payloads(OWNER, indexTopicHex(creator, 1)).length, 0);
  assert.ok(errors.mock.calls.some((c) => String(c.arguments[0]).includes("DROPPED")));
});
