/**
 * The directory rebuild, run end to end against fake storage.
 *
 * What is pinned here:
 *  - the pointer feed is generation 2, a different feed from the launch one;
 *  - a rebuild never takes "bee could not read the last snapshot" for "there is
 *    no snapshot": with a listing overlay that did not load, that would publish
 *    a directory missing every event the overlay no longer has a row for;
 *  - a feed read as never written is written at index 0 with no probe first, and
 *    bee's one-minute refusal of a missing first chunk is neither answer;
 *  - a rebuild with nothing to build on takes the whole registration table, not
 *    only what its trigger carried;
 *  - the published table holds only registrations that name a contract on the
 *    chain tickets sell on, and that rule decides which events count as registered;
 *  - an older snapshot read back from bee never replaces a newer one held;
 *  - a process started by the dev scripts never rebuilds the directory.
 *
 * The listing overlay is the real module on a temp `.data`, so the tests run in
 * order: the cases that need an overlay that did not load first, and rows only
 * ever accumulate after.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Topic } from "@ethersphere/bee-js";
import { EVENTS_SNAPSHOT_GENERATION, eventsSnapshotTopicName } from "@woco/shared";
import type { EventsSnapshot, EventsSnapshotPointer, Hex64, SnapshotCard, SnapshotResolutionEntry } from "@woco/shared";

type Snap = typeof import("../src/lib/event/directory-snapshot.js");
type LS = typeof import("../src/lib/event/listing-state.js");
type Feeds = typeof import("../src/lib/swarm/feeds.js");
type Topics = typeof import("../src/lib/swarm/topics.js");
type Busy = typeof import("../src/lib/swarm/storage-busy.js");
let snap: Snap;
let ls: LS;
let feeds: Feeds;
let topics: Topics;
let busy: Busy;

// Resolved before the chdir below: the dev entry points are read from the repo.
const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-directory-snapshot-")));
  ls = await import("../src/lib/event/listing-state.js");
  snap = await import("../src/lib/event/directory-snapshot.js");
  feeds = await import("../src/lib/swarm/feeds.js");
  topics = await import("../src/lib/swarm/topics.js");
  busy = await import("../src/lib/swarm/storage-busy.js");
});

const MAINNET = 42161;
const TESTNET = 421614;
const CONTRACT = ("0x" + "c1".repeat(20)) as SnapshotResolutionEntry["contract"];

function card(eventId: string, extra: Partial<SnapshotCard> = {}): SnapshotCard {
  return {
    eventId, title: eventId, imageHash: ("00".repeat(32)) as SnapshotCard["imageHash"],
    startDate: "2999-01-01", location: "", creatorAddress: ("0x" + "11".repeat(20)) as SnapshotCard["creatorAddress"],
    seriesCount: 1, totalTickets: 10, createdAt: "2026-01-01T00:00:00Z", tags: [], ...extra,
  };
}

function registration(wocoEventId: string, on?: { chainId?: number; contract?: boolean }): SnapshotResolutionEntry {
  return {
    onChainEventId: "0x" + Buffer.from(wocoEventId.padEnd(32, "_")).toString("hex"),
    wocoEventId,
    seriesId: `${wocoEventId}-series`,
    ...(on?.chainId !== undefined ? { chainId: on.chainId } : {}),
    ...(on?.contract !== false && on?.chainId !== undefined ? { contract: CONTRACT } : {}),
  };
}

type PointerState =
  | "absent"
  | "error"
  /** Bee refusing the feed's first chunk for a minute. */
  | "busy"
  | "garbage"
  /** A pointer naming this blob ref. */
  | { ref: string };

interface Harness {
  /** What a read of the feed answers. Not moved by writes: after its first write a rebuild builds on its own cache. */
  pointer: PointerState;
  /** ref -> blob JSON, or an Error the blob read throws. */
  blobs: Map<string, string | Error>;
  registrations: SnapshotResolutionEntry[];
  chainId: number;
  /** The next pointer write throws this, once. */
  failPointerWrite: Error | null;
  /** Every pointer written, in order, and whether each was written as a first update. */
  written: EventsSnapshotPointer[];
  fresh: boolean[];
  blobWrites: number;
  pointerReads: number;
  displayReads: number;
  registrationReads: number;
  cardReads: number;
  /** The snapshot behind the last pointer written. */
  last(): EventsSnapshot;
}

function install(
  init: Partial<Pick<Harness, "pointer" | "registrations" | "chainId">> & {
    blobs?: Record<string, string | Error>;
    /** Read registrations from the real registry and pinned-signer files, not `registrations`. */
    realRegistrations?: boolean;
  } = {},
): Harness {
  let nextRef = 1;
  const h: Harness = {
    pointer: init.pointer ?? "absent",
    blobs: new Map(Object.entries(init.blobs ?? {})),
    registrations: init.registrations ?? [],
    chainId: init.chainId ?? MAINNET,
    failPointerWrite: null,
    written: [],
    fresh: [],
    blobWrites: 0,
    pointerReads: 0,
    displayReads: 0,
    registrationReads: 0,
    cardReads: 0,
    last() {
      const p = h.written[h.written.length - 1];
      assert.ok(p, "nothing was written");
      return JSON.parse(h.blobs.get(p.snapshotRef) as string) as EventsSnapshot;
    },
  };
  const page = (ref: string) =>
    feeds.encodeJsonFeed({ v: 1, snapshotRef: ref as Hex64, builtAt: "2026-01-01T00:00:00Z", count: 0 } satisfies EventsSnapshotPointer);
  snap._setSnapshotIoForTest({
    async readPointer() {
      h.pointerReads++;
      if (h.pointer === "absent") return { status: "absent" };
      if (h.pointer === "error") return { status: "error", error: new Error("bee answered 500") };
      if (h.pointer === "busy") return { status: "error", error: new busy.FeedLookupCooldownError("lookup at failed and index 0 unreadable") };
      if (h.pointer === "garbage") return { status: "ok", data: new TextEncoder().encode("not json at all") };
      return { status: "ok", data: page(h.pointer.ref) };
    },
    async readPointerForDisplay() {
      h.displayReads++;
      if (h.pointer === "absent") return { status: "absent" };
      if (h.pointer === "error" || h.pointer === "busy") return { status: "error", error: new Error("bee answered 500") };
      if (h.pointer === "garbage") return { status: "ok", data: new TextEncoder().encode("not json at all") };
      return { status: "ok", data: page(h.pointer.ref) };
    },
    async readBlob(ref) {
      const blob = h.blobs.get(ref);
      if (blob === undefined) throw new Error("404 chunk not found");
      if (blob instanceof Error) throw blob;
      return blob;
    },
    async writeBlob(json) {
      h.blobWrites++;
      const ref = (nextRef++).toString(16).padStart(64, "0") as Hex64;
      h.blobs.set(ref, json);
      return ref;
    },
    async writePointer(bytes, fresh) {
      if (h.failPointerWrite) {
        const err = h.failPointerWrite;
        h.failPointerWrite = null;
        throw err;
      }
      const pointer = feeds.decodeJsonFeed<EventsSnapshotPointer>(bytes);
      assert.ok(pointer, "the pointer page must decode");
      h.written.push(pointer);
      h.fresh.push(fresh);
    },
    // The event's own content, as the builder would resolve it.
    async resolveCard(entry) {
      h.cardReads++;
      return card(entry.wocoEventId);
    },
    ...(init.realRegistrations
      ? {}
      : {
          registrations() {
            h.registrationReads++;
            return h.registrations;
          },
        }),
    activeChainId: () => h.chainId,
  });
  return h;
}

const PRIOR_REF = "ab".repeat(32);

function snapshotJson(cards: SnapshotCard[], resolution: SnapshotResolutionEntry[], builtAt = "2026-01-01T00:00:00Z"): string {
  const s: EventsSnapshot = { v: 1, builtAt, registrationCount: resolution.length, cards, resolution };
  return JSON.stringify(s);
}

const ids = (cards: SnapshotCard[]) => cards.map((c) => c.eventId).sort();
const tableIds = (resolution: SnapshotResolutionEntry[]) => resolution.map((e) => e.wocoEventId).sort();

/** Every way a pointer that exists can fail to give a snapshot (bee's one-minute refusal aside). */
const UNREADABLE: Array<[string, Parameters<typeof install>[0]]> = [
  ["the feed read failed", { pointer: "error" }],
  ["the pointer page is not a pointer", { pointer: "garbage" }],
  ["the blob is gone", { pointer: { ref: PRIOR_REF } }],
  ["the blob read failed", { pointer: { ref: PRIOR_REF }, blobs: { [PRIOR_REF]: new Error("socket hang up") } }],
  ["the blob is not a snapshot", { pointer: { ref: PRIOR_REF }, blobs: { [PRIOR_REF]: JSON.stringify({ v: 1 }) } }],
  ["the blob is not JSON", { pointer: { ref: PRIOR_REF }, blobs: { [PRIOR_REF]: "<html>" } }],
];

test("the pointer feed is generation 2, a different feed from the launch one", () => {
  assert.equal(EVENTS_SNAPSHOT_GENERATION, 2);
  assert.equal(eventsSnapshotTopicName(), "woco/event/directory/snapshot/2");
  // What the server reads and writes is that name, and not the launch feed's.
  const now = topics.topicEventsSnapshot().toHex();
  assert.equal(now, Topic.fromString("woco/event/directory/snapshot/2").toHex());
  assert.notEqual(now, Topic.fromString("woco/event/directory/snapshot").toHex());
});

// ---------------------------------------------------------------------------
// A listing overlay that did not load (here: its file is not there yet).
// Nothing below this block may run before it: its last test writes the file.
// ---------------------------------------------------------------------------

/** A restart with the overlay file still missing: memory may lack listed rows again. */
function overlayNotLoaded(): void {
  ls.__resetListingStateForTest();
  assert.equal(ls.needsRestoreFromSnapshot(), true, "these cases need an overlay that did not load");
}

test("overlay not loaded: a snapshot bee could not read refuses the rebuild and writes nothing", async () => {
  overlayNotLoaded();
  for (const [why, init] of UNREADABLE) {
    const h = install(init);
    await assert.rejects(snap.rebuildSnapshot({ full: true }), /listing overlay is incomplete/, why);
    assert.equal(h.written.length, 0, `${why}: nothing may be published`);
    assert.equal(h.blobWrites, 0, `${why}: nothing may be uploaded`);
    assert.equal(ls.needsRestoreFromSnapshot(), true, `${why}: still waiting for a snapshot it can restore from`);
  }
});

test("overlay not loaded: bee refusing the feed's first chunk is not \"never written\"", async () => {
  overlayNotLoaded();
  const h = install({ pointer: "busy" });
  await assert.rejects(snap.rebuildSnapshot({ full: true }), (err) => busy.isStorageBusy(err));
  assert.equal(h.written.length, 0);
  assert.equal(h.blobWrites, 0);
});

test("overlay not loaded: a feed never written gets its first snapshot, written as a first update", async () => {
  overlayNotLoaded();
  const h = install({ pointer: "absent" });
  await snap.rebuildSnapshot({ full: true });
  assert.equal(h.written.length, 1);
  assert.deepEqual(h.fresh, [true], "index 0, with no probe of the feed before it");
  assert.deepEqual(h.last().cards, []);
  assert.equal(h.written[0].count, 0);
  assert.equal(ls.needsRestoreFromSnapshot(), false, "no snapshot ever existed: there is nothing to restore");
});

test("overlay not loaded: a readable last snapshot restores the listing and its cards survive", async () => {
  overlayNotLoaded();
  const prior = snapshotJson([card("s1"), card("s2")], [registration("s1", { chainId: MAINNET })]);
  const h = install({ pointer: { ref: PRIOR_REF }, blobs: { [PRIOR_REF]: prior }, registrations: [registration("s1", { chainId: MAINNET })] });
  await snap.rebuildSnapshot({ full: true });
  assert.equal(ls.isListedForSnapshot("s1"), true, "s1 restored from the last snapshot");
  assert.equal(ls.isExplicitlyListed("s2"), true, "s2 (never registered) restored as a deliberate listing");
  assert.equal(ls.needsRestoreFromSnapshot(), false);
  // Same cards, same table: nothing new to publish, and the directory still serves both.
  assert.equal(h.written.length, 0);
  assert.deepEqual(ids((await snap.getEventsSnapshot())!.cards), ["s1", "s2"]);
  assert.equal(h.displayReads, 0, "served from what the rebuild read, with no second read of the feed");
});

// ---------------------------------------------------------------------------
// From here the overlay is whole: it holds s1 and s2, both listed.
// ---------------------------------------------------------------------------

test("a feed never written builds in full, even from a trigger that named one event", async () => {
  ls.setListed("e1", true, card("e1")); // listed at create, never by /list: needs its registration to show
  const h = install({
    pointer: "absent",
    registrations: [registration("s1", { chainId: MAINNET }), registration("e1", { chainId: MAINNET })],
  });
  await snap.rebuildSnapshot({ touchedEventIds: ["s2"] });
  assert.equal(h.registrationReads, 1, "the whole registration table was read");
  assert.deepEqual(tableIds(h.last().resolution), ["e1", "s1"]);
  assert.deepEqual(ids(h.last().cards), ["e1", "s1", "s2"]);
  assert.deepEqual(h.fresh, [true]);
});

test("the first rebuild of a process is full, even on a snapshot it read", async () => {
  // What bee gave back at restart is the update before the newest: e1's registration is not in it.
  const stale = snapshotJson([card("s1"), card("s2")], [registration("s1", { chainId: MAINNET })]);
  const h = install({
    pointer: { ref: PRIOR_REF },
    blobs: { [PRIOR_REF]: stale },
    registrations: [registration("s1", { chainId: MAINNET }), registration("e1", { chainId: MAINNET })],
  });
  await snap.rebuildSnapshot({ touchedEventIds: ["s2"] });
  assert.equal(h.registrationReads, 1, "built from the server's own records, not on the snapshot it read");
  assert.deepEqual(tableIds(h.last().resolution), ["e1", "s1"]);
  assert.deepEqual(ids(h.last().cards), ["e1", "s1", "s2"]);
  assert.deepEqual(h.fresh, [false]);
});

test("once this process has rebuilt, a trigger stays incremental and the write is an ordinary update", async () => {
  const prior = snapshotJson([card("s1"), card("s2")], [registration("s1", { chainId: MAINNET })]);
  const h = install({ pointer: { ref: PRIOR_REF }, blobs: { [PRIOR_REF]: prior }, registrations: [registration("s1", { chainId: MAINNET })] });
  await snap.rebuildSnapshot({ full: true });
  assert.equal(h.written.length, 0, "the full rebuild found nothing to change");
  assert.equal(h.registrationReads, 1);

  h.registrations = [...h.registrations, registration("unseen", { chainId: MAINNET })];
  await snap.rebuildSnapshot({ addResolution: [registration("e1", { chainId: MAINNET })] });
  assert.equal(h.registrationReads, 1, "an incremental rebuild takes its table from the snapshot held, plus its trigger");
  assert.deepEqual(tableIds(h.last().resolution), ["e1", "s1"]);
  assert.deepEqual(ids(h.last().cards), ["e1", "s1", "s2"]);
  assert.deepEqual(h.fresh, [false]);
});

test("an unreadable snapshot with the overlay whole rebuilds in full from server records", async () => {
  for (const [why, init] of UNREADABLE) {
    const h = install({ ...init, registrations: [registration("s1", { chainId: MAINNET }), registration("e1", { chainId: MAINNET })] });
    await snap.rebuildSnapshot({ touchedEventIds: ["s2"] });
    assert.equal(h.written.length, 1, why);
    assert.equal(h.registrationReads, 1, why);
    assert.deepEqual(ids(h.last().cards), ["e1", "s1", "s2"], why);
    assert.deepEqual(h.fresh, [false], `${why}: a feed that exists is never written as a first update`);
  }
});

test("bee refusing the feed's first chunk stops the rebuild before anything is uploaded, overlay whole or not", async () => {
  const h = install({ pointer: "busy", registrations: [registration("s1", { chainId: MAINNET })] });
  await assert.rejects(snap.rebuildSnapshot({ full: true }), (err) => busy.isStorageBusy(err));
  assert.equal(h.blobWrites, 0);
  assert.equal(h.written.length, 0);
});

test("a pointer write that fails publishes nothing, and the next rebuild tries again from the same start", async () => {
  const h = install({ pointer: "absent", registrations: [registration("s1", { chainId: MAINNET })] });
  h.failPointerWrite = new Error("socket hang up");
  await assert.rejects(snap.rebuildSnapshot({ full: true }), /socket hang up/);
  assert.equal(h.written.length, 0);
  assert.equal(await snap.getEventsSnapshot(), null, "an unpublished snapshot is never served");
  await snap.rebuildSnapshot({ full: true });
  assert.equal(h.written.length, 1);
  assert.deepEqual(h.fresh, [true], "still a first update: nothing was written the first time");
  assert.deepEqual(ids(h.last().cards), ["s1", "s2"]);
});

test("when the write fails, the directory goes on serving the snapshot the rebuild read", async () => {
  const prior = snapshotJson([card("s1")], [registration("s1", { chainId: MAINNET })]);
  const h = install({
    pointer: { ref: PRIOR_REF },
    blobs: { [PRIOR_REF]: prior },
    registrations: [registration("s1", { chainId: MAINNET }), registration("e1", { chainId: MAINNET })],
  });
  h.failPointerWrite = new Error("socket hang up");
  await assert.rejects(snap.rebuildSnapshot({ full: true }), /socket hang up/);
  assert.deepEqual(ids((await snap.getEventsSnapshot())!.cards), ["s1"]);
  assert.equal(h.displayReads, 0, "from the rebuild's own read, not a second one");
});

test("the published table holds only registrations that name a contract on the active chain", async () => {
  ls.setListed("cur1", true, card("cur1"));                              // registered on the active chain
  ls.setListed("old1", true, card("old1"));                              // registered on another chain only
  ls.setListed("old2", true, card("old2"));                              // registered before contracts were recorded
  ls.setListed("old3", true, card("old3"), { explicitlyListed: true });  // as old2, but listed deliberately
  const h = install({
    pointer: "absent",
    chainId: MAINNET,
    registrations: [
      registration("cur1", { chainId: MAINNET }),
      registration("old1", { chainId: TESTNET }),
      registration("old2"),
      registration("old3"),
      registration("nocontract", { chainId: MAINNET, contract: false }),
    ],
  });
  await snap.rebuildSnapshot({
    full: true,
    addResolution: [registration("e1", { chainId: MAINNET }), registration("trigger-old", { chainId: TESTNET })],
  });
  const published = h.last();
  assert.deepEqual(tableIds(published.resolution), ["cur1", "e1"]);
  assert.equal(published.registrationCount, 2);
  // Out of the table means "not registered" to the builder: old1 and old2 are
  // hidden, old3 shows because it was listed deliberately (as s1 and s2 were, by
  // the reseed above).
  assert.deepEqual(ids(published.cards), ["cur1", "e1", "old3", "s1", "s2"]);
});

test("an entry already published drops out when the active chain moves", async () => {
  const h = install({
    pointer: "absent",
    chainId: MAINNET,
    registrations: [registration("cur1", { chainId: MAINNET }), registration("old1", { chainId: TESTNET })],
  });
  await snap.rebuildSnapshot({ full: true });
  assert.deepEqual(tableIds(h.last().resolution), ["cur1"]);
  h.chainId = TESTNET;
  await snap.rebuildSnapshot({ full: true });
  assert.equal(h.written.length, 2);
  assert.deepEqual(tableIds(h.last().resolution), ["old1"]);
  assert.equal(h.pointerReads, 1, "the second rebuild built on what the first published");
  assert.deepEqual(h.fresh, [true, false], "only the first write of a feed is a first update");
});

test("a rebuild with nothing to build on still publishes each event's pinned feed signer", async () => {
  const registry = await import("../src/lib/event/onchain-registry.js");
  const signers = await import("../src/lib/event/feed-signer-record.js");
  const target = { chainId: MAINNET, address: "0x" + "c1".repeat(20), version: "ledger2" as const };
  const SIGNER = "0x" + "5a".repeat(20);
  const pinned = "11111111-1111-4111-8111-111111111111";
  const unpinned = "22222222-2222-4222-8222-222222222222";
  registry.recordOnChainEventId(pinned, "series-0001", "0x" + "01".repeat(32), target);
  registry.recordOnChainEventId(unpinned, "series-0002", "0x" + "02".repeat(32), target);
  signers.recordEventFeedSigner(pinned, SIGNER, "0x" + "11".repeat(20));

  const h = install({ pointer: "absent", realRegistrations: true });
  await snap.rebuildSnapshot({ full: true });
  const table = new Map(h.last().resolution.map((e) => [e.wocoEventId, e]));
  assert.equal(table.get(pinned)?.creatorFeedSigner, SIGNER);
  assert.ok(table.has(unpinned), "an event with no pinned signer is still in the table");
  assert.equal(table.get(unpinned)?.creatorFeedSigner, undefined);
});

test("a signer the last snapshot carried survives a full rebuild that has no record of it", async () => {
  const SIGNER = ("0x" + "7b".repeat(20)) as SnapshotResolutionEntry["creatorFeedSigner"];
  const prior = snapshotJson([card("s1")], [{ ...registration("s1", { chainId: MAINNET }), creatorFeedSigner: SIGNER }]);
  const h = install({
    pointer: { ref: PRIOR_REF },
    blobs: { [PRIOR_REF]: prior },
    // The server's own registrations name s1 without a signer, and add cur1.
    registrations: [registration("s1", { chainId: MAINNET }), registration("cur1", { chainId: MAINNET })],
  });
  await snap.rebuildSnapshot({ full: true });
  const s1 = h.last().resolution.find((e) => e.wocoEventId === "s1");
  assert.equal(s1?.creatorFeedSigner, SIGNER);
});

test("a rebuild that changes nothing writes nothing", async () => {
  const h = install({ pointer: "absent", registrations: [registration("cur1", { chainId: MAINNET })] });
  await snap.rebuildSnapshot({ full: true });
  await snap.rebuildSnapshot({ full: true });
  await snap.rebuildSnapshot({ touchedEventIds: ["cur1"] });
  assert.equal(h.written.length, 1);
});

// ---------------------------------------------------------------------------
// The display read
// ---------------------------------------------------------------------------

test("an older snapshot read back from bee never replaces the newer one held", async () => {
  const h = install({ pointer: "absent", registrations: [registration("cur1", { chainId: MAINNET })] });
  await snap.rebuildSnapshot({ full: true });
  const built = h.last();
  // Bee's lookup is a lower bound: minutes after a write it can still answer with the update before it.
  h.blobs.set(PRIOR_REF, snapshotJson([card("stale")], [], "2020-01-01T00:00:00.000Z"));
  h.pointer = { ref: PRIOR_REF };
  await snap._refreshSnapshotForTest();
  assert.deepEqual((await snap.getEventsSnapshot())!.cards, built.cards, "the display keeps the newer snapshot");
  // And the next rebuild builds on the newer one: nothing to change, so nothing written.
  await snap.rebuildSnapshot({ touchedEventIds: ["cur1"] });
  assert.equal(h.written.length, 1);
  assert.equal(h.registrationReads, 1, "incremental: this process built the snapshot it holds");

  h.blobs.set(PRIOR_REF, snapshotJson([card("newer")], [], "2999-01-01T00:00:00.000Z"));
  await snap._refreshSnapshotForTest();
  assert.deepEqual(ids((await snap.getEventsSnapshot())!.cards), ["newer"], "a newer one is taken");
});

test("\"never written\" is held for a minute, then asked again", async () => {
  let t = 1_000_000;
  snap._setSnapshotClockForTest(() => t);
  try {
    const h = install({ pointer: "absent" });
    assert.equal(await snap.getEventsSnapshot(), null);
    assert.equal(await snap.getEventsSnapshot(), null);
    t += 59_000;
    assert.equal(await snap.getEventsSnapshot(), null);
    assert.equal(h.displayReads, 1, "one read of a feed that is not there, however many requests");
    t += 1_000;
    assert.equal(await snap.getEventsSnapshot(), null);
    assert.equal(h.displayReads, 2, "asked again once the minute is up");
  } finally {
    snap._setSnapshotClockForTest(null);
  }
});

test("a read that could not answer is never held as \"nothing there\"", async () => {
  const prior = snapshotJson([card("s1")], [registration("s1", { chainId: MAINNET })]);
  for (const pointer of ["error", "garbage"] as const) {
    const h = install({ pointer, blobs: { [PRIOR_REF]: prior } });
    assert.equal(await snap.getEventsSnapshot(), null);
    h.pointer = { ref: PRIOR_REF };
    assert.deepEqual(ids((await snap.getEventsSnapshot())!.cards), ["s1"], `${pointer}: the next request reads again`);
    assert.equal(h.displayReads, 2);
  }
});

test("a new snapshot is never dated before the one it replaces", async () => {
  const prior = snapshotJson([card("s1")], [registration("s1", { chainId: MAINNET })], "2999-01-01T00:00:00.000Z");
  const h = install({
    pointer: { ref: PRIOR_REF },
    blobs: { [PRIOR_REF]: prior },
    registrations: [registration("s1", { chainId: MAINNET }), registration("cur1", { chainId: MAINNET })],
  });
  await snap.rebuildSnapshot({ full: true });
  assert.equal(h.written.length, 1);
  assert.ok(h.last().builtAt > "2999-01-01T00:00:00.000Z", `${h.last().builtAt} must sort after the base`);
});

// ---------------------------------------------------------------------------
// At boot
// ---------------------------------------------------------------------------

test("boot: an existing snapshot is read once and nothing is rebuilt", async () => {
  const prior = snapshotJson([card("s1"), card("s2")], [registration("s1", { chainId: MAINNET })]);
  const h = install({
    pointer: { ref: PRIOR_REF },
    blobs: { [PRIOR_REF]: prior },
    // A reconcile here would add cur1 and publish; boot must not.
    registrations: [registration("s1", { chainId: MAINNET }), registration("cur1", { chainId: MAINNET })],
  });
  await snap.startDirectoryAtBoot(() => assert.fail("nothing to retry"));
  assert.equal(h.pointerReads, 1);
  assert.equal(h.cardReads, 0, "no event is resolved again at boot");
  assert.equal(h.written.length, 0);
  assert.equal(h.blobWrites, 0);
  assert.deepEqual(ids((await snap.getEventsSnapshot())!.cards), ["s1", "s2"]);
  assert.equal(h.displayReads, 0, "the display serves what boot read");
});

test("boot: a feed never written gets its first snapshot, from one read of it", async () => {
  const h = install({ pointer: "absent", registrations: [registration("cur1", { chainId: MAINNET })] });
  await snap.startDirectoryAtBoot(() => assert.fail("nothing to retry"));
  assert.equal(h.pointerReads, 1, "the rebuild does not read the missing feed a second time");
  assert.equal(h.written.length, 1);
  assert.deepEqual(h.fresh, [true]);
  assert.ok(ids(h.last().cards).includes("cur1"));
});

test("boot: its rebuild does not write a first update over a snapshot another rebuild wrote meanwhile", async () => {
  const h = install({ pointer: "absent", registrations: [registration("cur1", { chainId: MAINNET })] });
  // A trigger's rebuild ran between boot's read and boot's own rebuild.
  await snap.rebuildSnapshot({ full: true });
  assert.deepEqual(h.fresh, [true]);
  h.registrations = [...h.registrations, registration("e1", { chainId: MAINNET })];
  await snap.rebuildSnapshot({ full: true, knownNeverWritten: true });
  assert.deepEqual(h.fresh, [true, false], "the feed exists now: an ordinary update, built on what is held");
});

test("boot: storage busy is retried past the window, and the first snapshot is then published", async () => {
  const h = install({ pointer: "busy", registrations: [registration("cur1", { chainId: MAINNET })] });
  const retries: Array<{ ms: number; run: () => Promise<void> }> = [];
  const retryIn = (ms: number, run: () => Promise<void>) => void retries.push({ ms, run });
  await snap.startDirectoryAtBoot(retryIn);
  assert.equal(h.written.length, 0);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].ms, busy.STORAGE_BUSY_RETRY_MS);

  h.pointer = "absent";
  await retries[0].run();
  assert.equal(h.written.length, 1);
  assert.deepEqual(h.fresh, [true]);
  assert.equal(retries.length, 1, "a start that worked asks for no more retries");
});

test("boot: storage busy is retried twice, then left to the 30-minute reconcile", async () => {
  const h = install({ pointer: "busy" });
  const retries: Array<() => Promise<void>> = [];
  const retryIn = (_ms: number, run: () => Promise<void>) => void retries.push(run);
  await snap.startDirectoryAtBoot(retryIn);
  assert.equal(retries.length, 1);
  await retries[0]();
  assert.equal(retries.length, 2);
  assert.equal(snap.directoryHealth().ok, true, "still trying: not an alarm yet");
  await retries[1]();
  assert.equal(retries.length, 2, "no third retry");
  assert.equal(h.pointerReads, 3, "three attempts in all");
  assert.equal(snap.directoryHealth().ok, false, "boot is over and the directory is serving nothing");
});

test("boot: an unreadable snapshot, or a first write that fails, is not retried and nothing is published", async () => {
  for (const [why, init] of UNREADABLE) {
    const h = install(init);
    await snap.startDirectoryAtBoot(() => assert.fail(`${why}: nothing to retry`));
    assert.equal(h.written.length, 0, why);
    assert.equal(h.blobWrites, 0, `${why}: left to the reconcile, which knows what to do with it`);
  }
  const h = install({ pointer: "absent" });
  h.failPointerWrite = new Error("batch not usable");
  await snap.startDirectoryAtBoot(() => assert.fail("a write failure is not storage busy"));
  assert.equal(h.written.length, 0);
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

test("health: green while publishing, with what is being served", async () => {
  const h = install({ pointer: "absent", registrations: [registration("cur1", { chainId: MAINNET })] });
  assert.deepEqual(snap.directoryHealth(), { ok: true, publishing: true, failedRebuilds: 0, builtAt: null, cards: null });
  await snap.rebuildSnapshot({ full: true });
  const health = snap.directoryHealth();
  assert.equal(health.ok, true);
  assert.equal(health.builtAt, h.last().builtAt);
  assert.equal(health.cards, h.last().cards.length);
});

test("health: red when boot is over and nothing is held, green as soon as a read works", async () => {
  const prior = snapshotJson([card("s1")], [registration("s1", { chainId: MAINNET })]);
  const h = install({ pointer: "error", blobs: { [PRIOR_REF]: prior } });
  await snap.startDirectoryAtBoot(() => assert.fail("nothing to retry"));
  assert.deepEqual([snap.directoryHealth().ok, snap.directoryHealth().cards], [false, null]);
  h.pointer = { ref: PRIOR_REF };
  await snap.getEventsSnapshot();
  assert.deepEqual([snap.directoryHealth().ok, snap.directoryHealth().cards], [true, 1]);
});

test("health: red after three rebuilds fail in a row, green again after one that works", async () => {
  const h = install({ pointer: "error" });
  // The overlay is whole, so an unreadable snapshot is rebuilt: make the write fail.
  for (let i = 1; i <= 3; i++) {
    h.failPointerWrite = new Error("batch not usable");
    await assert.rejects(snap.rebuildSnapshot({ full: true }));
    assert.equal(snap.directoryHealth().failedRebuilds, i);
    assert.equal(snap.directoryHealth().ok, i < 3, `after ${i} failure(s)`);
  }
  await snap.rebuildSnapshot({ full: true });
  assert.deepEqual([snap.directoryHealth().failedRebuilds, snap.directoryHealth().ok], [0, true]);
});

// ---------------------------------------------------------------------------
// A process that must not publish (the dev scripts)
// ---------------------------------------------------------------------------

test("DIRECTORY_PUBLISH=off: a rebuild reads nothing and writes nothing, and the directory still reads", async () => {
  const prior = snapshotJson([card("s1")], [registration("s1", { chainId: MAINNET })]);
  const h = install({ pointer: { ref: PRIOR_REF }, blobs: { [PRIOR_REF]: prior }, registrations: [registration("cur1", { chainId: MAINNET })] });
  process.env.DIRECTORY_PUBLISH = "off";
  try {
    assert.equal(snap.directoryPublishingEnabled(), false);
    await snap.rebuildSnapshot({ full: true });
    await snap.rebuildSnapshotFull();
    await snap.startDirectoryAtBoot(() => assert.fail("nothing to retry"));
    assert.equal(h.pointerReads, 0);
    assert.equal(h.blobWrites, 0);
    assert.equal(h.written.length, 0);
    assert.deepEqual(ids((await snap.getEventsSnapshot())!.cards), ["s1"]);
    assert.deepEqual([snap.directoryHealth().publishing, snap.directoryHealth().ok], [false, false], "an alarm, wherever it is not a dev server");
  } finally {
    delete process.env.DIRECTORY_PUBLISH;
  }
  assert.equal(snap.directoryPublishingEnabled(), true, "anything but \"off\" publishes: production sets nothing");
});

test("both dev start commands switch directory publishing off", () => {
  const pkg = JSON.parse(readFileSync(join(SERVER_DIR, "package.json"), "utf-8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts.dev, "node scripts/dev-with-tunnel.mjs");
  const tunnel = readFileSync(join(SERVER_DIR, "scripts/dev-with-tunnel.mjs"), "utf-8");
  const set = tunnel.search(/^devEnv\.DIRECTORY_PUBLISH = "off";$/m);
  const start = tunnel.indexOf("env: devEnv");
  assert.ok(set !== -1, "the tunnel script sets the switch");
  assert.ok(start !== -1 && set < start, "and sets it before it starts the server with that environment");
  assert.match(pkg.scripts["dev:notunnel"], /(^| )DIRECTORY_PUBLISH=off (.* )?tsx /, "set before the command it applies to");
  // The production start command must not carry it.
  assert.doesNotMatch(pkg.scripts.start, /DIRECTORY_PUBLISH/);
});
