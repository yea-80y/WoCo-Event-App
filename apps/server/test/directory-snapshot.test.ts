/**
 * The directory rebuild, run end to end against fake storage.
 *
 * What is pinned here:
 *  - the pointer feed is generation 2, a different feed from the launch one;
 *  - a rebuild never takes "bee could not read the last snapshot" for "there is
 *    no snapshot": with an empty listing overlay that would publish an empty
 *    directory over a live one;
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
 * order: the empty-overlay cases first, and rows only ever accumulate after.
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
      if (typeof h.pointer === "string") return h.pointer === "garbage" ? new TextEncoder().encode("not json at all") : null;
      return page(h.pointer.ref);
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
// Empty overlay. Nothing below this block may run before it.
// ---------------------------------------------------------------------------

test("empty overlay: a snapshot bee could not read refuses the rebuild and writes nothing", async () => {
  assert.equal(ls.hasAnyRows(), false, "these cases need the overlay empty");
  for (const [why, init] of UNREADABLE) {
    const h = install(init);
    await assert.rejects(snap.rebuildSnapshot({ full: true }), /listing overlay is empty/, why);
    assert.equal(h.written.length, 0, `${why}: nothing may be published`);
    assert.equal(h.blobWrites, 0, `${why}: nothing may be uploaded`);
  }
});

test("empty overlay: bee refusing the feed's first chunk is not \"never written\"", async () => {
  assert.equal(ls.hasAnyRows(), false);
  const h = install({ pointer: "busy" });
  await assert.rejects(snap.rebuildSnapshot({ full: true }), (err) => busy.isStorageBusy(err));
  assert.equal(h.written.length, 0);
  assert.equal(h.blobWrites, 0);
});

test("empty overlay: a feed never written gets its first snapshot, written as a first update", async () => {
  assert.equal(ls.hasAnyRows(), false);
  const h = install({ pointer: "absent" });
  await snap.rebuildSnapshot({ full: true });
  assert.equal(h.written.length, 1);
  assert.deepEqual(h.fresh, [true], "index 0, with no probe of the feed before it");
  assert.deepEqual(h.last().cards, []);
  assert.equal(h.written[0].count, 0);
});

test("empty overlay: a readable last snapshot reseeds the overlay and its cards survive", async () => {
  assert.equal(ls.hasAnyRows(), false);
  const prior = snapshotJson([card("s1"), card("s2")], [registration("s1", { chainId: MAINNET })]);
  const h = install({ pointer: { ref: PRIOR_REF }, blobs: { [PRIOR_REF]: prior }, registrations: [registration("s1", { chainId: MAINNET })] });
  await snap.rebuildSnapshot({ full: true });
  assert.equal(ls.isListedForSnapshot("s1"), true, "s1 reseeded from the last snapshot");
  assert.equal(ls.isExplicitlyListed("s2"), true, "s2 (never registered) reseeded as a deliberate listing");
  // Same cards, same table: nothing new to publish, and the directory still serves both.
  assert.equal(h.written.length, 0);
  assert.deepEqual(ids((await snap.getEventsSnapshot())!.cards), ["s1", "s2"]);
  assert.equal(h.displayReads, 0, "served from what the rebuild read, with no second read of the feed");
});

// ---------------------------------------------------------------------------
// From here the overlay holds s1 and s2, both listed.
// ---------------------------------------------------------------------------

test("a new generation builds in full, even from a trigger that named one event", async () => {
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

test("with a snapshot to build on, a trigger stays incremental and the write is an ordinary update", async () => {
  const prior = snapshotJson([card("s1"), card("s2")], [registration("s1", { chainId: MAINNET })]);
  const h = install({
    pointer: { ref: PRIOR_REF },
    blobs: { [PRIOR_REF]: prior },
    registrations: [registration("s1", { chainId: MAINNET }), registration("e1", { chainId: MAINNET })],
  });
  await snap.rebuildSnapshot({ addResolution: [registration("e1", { chainId: MAINNET })] });
  assert.equal(h.registrationReads, 0, "an incremental rebuild takes its table from the last snapshot");
  assert.deepEqual(tableIds(h.last().resolution), ["e1", "s1"]);
  assert.deepEqual(ids(h.last().cards), ["e1", "s1", "s2"]);
  assert.deepEqual(h.fresh, [false]);
});

test("an unreadable snapshot with overlay rows rebuilds in full from server records", async () => {
  for (const [why, init] of UNREADABLE) {
    const h = install({ ...init, registrations: [registration("s1", { chainId: MAINNET }), registration("e1", { chainId: MAINNET })] });
    await snap.rebuildSnapshot({ touchedEventIds: ["s2"] });
    assert.equal(h.written.length, 1, why);
    assert.equal(h.registrationReads, 1, why);
    assert.deepEqual(ids(h.last().cards), ["e1", "s1", "s2"], why);
    assert.deepEqual(h.fresh, [false], `${why}: a feed that exists is never written as a first update`);
  }
});

test("bee refusing the feed's first chunk stops the rebuild before anything is uploaded, overlay rows or not", async () => {
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

  h.blobs.set(PRIOR_REF, snapshotJson([card("newer")], [], "2999-01-01T00:00:00.000Z"));
  await snap._refreshSnapshotForTest();
  assert.deepEqual(ids((await snap.getEventsSnapshot())!.cards), ["newer"], "a newer one is taken");
});

test("a read that found no snapshot is not repeated on every request", async () => {
  const h = install({ pointer: "absent" });
  assert.equal(await snap.getEventsSnapshot(), null);
  assert.equal(await snap.getEventsSnapshot(), null);
  assert.equal(await snap.getEventsSnapshot(), null);
  assert.equal(h.displayReads, 1);
});

// ---------------------------------------------------------------------------
// The reconcile at boot
// ---------------------------------------------------------------------------

test("boot: storage busy is retried past the window, and the first snapshot is then published", async () => {
  const h = install({ pointer: "busy", registrations: [registration("cur1", { chainId: MAINNET })] });
  const retries: Array<{ ms: number; run: () => Promise<void> }> = [];
  const retryIn = (ms: number, run: () => Promise<void>) => void retries.push({ ms, run });
  await snap.reconcileAtBoot(retryIn);
  assert.equal(h.written.length, 0);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].ms, busy.STORAGE_BUSY_RETRY_MS);

  h.pointer = "absent";
  await retries[0].run();
  assert.equal(h.written.length, 1);
  assert.deepEqual(h.fresh, [true]);
  assert.equal(retries.length, 1, "a reconcile that worked asks for no more retries");
});

test("boot: storage busy is retried twice, then left to the 30-minute reconcile", async () => {
  const h = install({ pointer: "busy" });
  const retries: Array<() => Promise<void>> = [];
  const retryIn = (_ms: number, run: () => Promise<void>) => void retries.push(run);
  await snap.reconcileAtBoot(retryIn);
  assert.equal(retries.length, 1);
  await retries[0]();
  assert.equal(retries.length, 2);
  await retries[1]();
  assert.equal(retries.length, 2, "no third retry");
  assert.equal(h.pointerReads, 3, "three attempts in all");
});

test("boot: a failure that is not storage busy is not retried", async () => {
  const h = install({ pointer: "absent" });
  h.failPointerWrite = new Error("batch not usable");
  const retries: Array<() => Promise<void>> = [];
  await snap.reconcileAtBoot((_ms, run) => void retries.push(run));
  assert.equal(retries.length, 0);
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
    await snap.reconcileAtBoot(() => assert.fail("nothing to retry"));
    assert.equal(h.pointerReads, 0);
    assert.equal(h.blobWrites, 0);
    assert.equal(h.written.length, 0);
    assert.deepEqual(ids((await snap.getEventsSnapshot())!.cards), ["s1"]);
  } finally {
    delete process.env.DIRECTORY_PUBLISH;
  }
  assert.equal(snap.directoryPublishingEnabled(), true, "anything but \"off\" publishes: production sets nothing");
});

test("both dev start commands switch directory publishing off", () => {
  const pkg = JSON.parse(readFileSync(join(SERVER_DIR, "package.json"), "utf-8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts.dev, "node scripts/dev-with-tunnel.mjs");
  assert.match(readFileSync(join(SERVER_DIR, "scripts/dev-with-tunnel.mjs"), "utf-8"), /^devEnv\.DIRECTORY_PUBLISH = "off";$/m);
  assert.match(pkg.scripts["dev:notunnel"], /(^| )DIRECTORY_PUBLISH=off /);
  // The production start command must not carry it.
  assert.doesNotMatch(pkg.scripts.start, /DIRECTORY_PUBLISH/);
});
