/**
 * The directory rebuild, run end to end against fake storage.
 *
 * What is pinned here:
 *  - the pointer feed is generation 2, a different feed from the launch one;
 *  - a rebuild never takes "bee could not read the last snapshot" for "there is
 *    no snapshot": with an empty listing overlay that would publish an empty
 *    directory over a live one;
 *  - a rebuild with nothing to build on takes the whole registration table, not
 *    only what its trigger carried;
 *  - the published table holds only registrations that name a contract on the
 *    chain tickets sell on, and that rule decides which events count as registered.
 *
 * The listing overlay is the real module on a temp `.data`, so the tests run in
 * order: the empty-overlay cases first, and rows only ever accumulate after.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Topic } from "@ethersphere/bee-js";
import { EVENTS_SNAPSHOT_GENERATION, eventsSnapshotTopicName } from "@woco/shared";
import type { EventsSnapshot, EventsSnapshotPointer, Hex64, SnapshotCard, SnapshotResolutionEntry } from "@woco/shared";

type Snap = typeof import("../src/lib/event/directory-snapshot.js");
type LS = typeof import("../src/lib/event/listing-state.js");
type Feeds = typeof import("../src/lib/swarm/feeds.js");
type Topics = typeof import("../src/lib/swarm/topics.js");
let snap: Snap;
let ls: LS;
let feeds: Feeds;
let topics: Topics;

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-directory-snapshot-")));
  ls = await import("../src/lib/event/listing-state.js");
  snap = await import("../src/lib/event/directory-snapshot.js");
  feeds = await import("../src/lib/swarm/feeds.js");
  topics = await import("../src/lib/swarm/topics.js");
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
  | "garbage"
  /** A pointer naming this blob ref. */
  | { ref: string };

interface Harness {
  /** What the feed read answers. Fixed for the harness: after its first write a rebuild builds on its own cache. */
  pointer: PointerState;
  /** ref -> blob JSON, or an Error the blob read throws. */
  blobs: Map<string, string | Error>;
  registrations: SnapshotResolutionEntry[];
  chainId: number;
  /** Every pointer written, in order. */
  written: EventsSnapshotPointer[];
  pointerReads: number;
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
    written: [],
    pointerReads: 0,
    registrationReads: 0,
    last() {
      const p = h.written[h.written.length - 1];
      assert.ok(p, "nothing was written");
      return JSON.parse(h.blobs.get(p.snapshotRef) as string) as EventsSnapshot;
    },
  };
  snap._setSnapshotIoForTest({
    async readPointer() {
      h.pointerReads++;
      if (h.pointer === "absent") return { status: "absent" };
      if (h.pointer === "error") return { status: "error", error: new Error("bee answered 500") };
      if (h.pointer === "garbage") return { status: "ok", data: new TextEncoder().encode("not json at all") };
      const page: EventsSnapshotPointer = { v: 1, snapshotRef: h.pointer.ref as Hex64, builtAt: "2026-01-01T00:00:00Z", count: 0 };
      return { status: "ok", data: feeds.encodeJsonFeed(page) };
    },
    async readBlob(ref) {
      const blob = h.blobs.get(ref);
      if (blob === undefined) throw new Error("404 chunk not found");
      if (blob instanceof Error) throw blob;
      return blob;
    },
    async writeBlob(json) {
      const ref = (nextRef++).toString(16).padStart(64, "0") as Hex64;
      h.blobs.set(ref, json);
      return ref;
    },
    async writePointer(page) {
      const pointer = feeds.decodeJsonFeed<EventsSnapshotPointer>(page);
      assert.ok(pointer, "the pointer page must decode");
      h.written.push(pointer);
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

function priorSnapshot(cards: SnapshotCard[], resolution: SnapshotResolutionEntry[]): string {
  const s: EventsSnapshot = { v: 1, builtAt: "2026-01-01T00:00:00Z", registrationCount: resolution.length, cards, resolution };
  return JSON.stringify(s);
}

const ids = (cards: SnapshotCard[]) => cards.map((c) => c.eventId).sort();
const tableIds = (resolution: SnapshotResolutionEntry[]) => resolution.map((e) => e.wocoEventId).sort();

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
  const unreadable: Array<[string, Parameters<typeof install>[0]]> = [
    ["the feed read failed", { pointer: "error" }],
    ["the pointer page is not a pointer", { pointer: "garbage" }],
    ["the blob is gone", { pointer: { ref: PRIOR_REF } }],
    ["the blob read failed", { pointer: { ref: PRIOR_REF }, blobs: { [PRIOR_REF]: new Error("socket hang up") } }],
    ["the blob is not a snapshot", { pointer: { ref: PRIOR_REF }, blobs: { [PRIOR_REF]: JSON.stringify({ v: 1 }) } }],
    ["the blob is not JSON", { pointer: { ref: PRIOR_REF }, blobs: { [PRIOR_REF]: "<html>" } }],
  ];
  for (const [why, init] of unreadable) {
    const h = install(init);
    await assert.rejects(snap.rebuildSnapshot({ full: true }), /listing overlay is empty/, why);
    assert.equal(h.written.length, 0, `${why}: nothing may be published`);
  }
});

test("empty overlay: a feed never written is not an unreadable one, so the first snapshot is published", async () => {
  assert.equal(ls.hasAnyRows(), false);
  const h = install({ pointer: "absent" });
  await snap.rebuildSnapshot({ full: true });
  assert.equal(h.written.length, 1);
  assert.deepEqual(h.last().cards, []);
  assert.equal(h.written[0].count, 0);
});

test("empty overlay: a readable last snapshot reseeds the overlay and its cards survive", async () => {
  assert.equal(ls.hasAnyRows(), false);
  const prior = priorSnapshot(
    [card("s1"), card("s2")],
    [registration("s1", { chainId: MAINNET })],
  );
  const h = install({ pointer: { ref: PRIOR_REF }, blobs: { [PRIOR_REF]: prior }, registrations: [registration("s1", { chainId: MAINNET })] });
  await snap.rebuildSnapshot({ full: true });
  assert.equal(ls.isListedForSnapshot("s1"), true, "s1 reseeded from the last snapshot");
  assert.equal(ls.isExplicitlyListed("s2"), true, "s2 (never registered) reseeded as a deliberate listing");
  // Same cards, same table: nothing new to publish, and the directory still serves both.
  assert.equal(h.written.length, 0);
  assert.deepEqual(ids((await snap.getEventsSnapshot())!.cards), ["s1", "s2"]);
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
});

test("with a snapshot to build on, a trigger stays incremental", async () => {
  const prior = priorSnapshot([card("s1"), card("s2")], [registration("s1", { chainId: MAINNET })]);
  const h = install({
    pointer: { ref: PRIOR_REF },
    blobs: { [PRIOR_REF]: prior },
    registrations: [registration("s1", { chainId: MAINNET }), registration("e1", { chainId: MAINNET })],
  });
  await snap.rebuildSnapshot({ addResolution: [registration("e1", { chainId: MAINNET })] });
  assert.equal(h.registrationReads, 0, "an incremental rebuild takes its table from the last snapshot");
  assert.deepEqual(tableIds(h.last().resolution), ["e1", "s1"]);
  assert.deepEqual(ids(h.last().cards), ["e1", "s1", "s2"]);
});

test("an unreadable snapshot with overlay rows rebuilds in full from server records", async () => {
  const cases: Array<[string, Parameters<typeof install>[0]]> = [
    ["the feed read failed", { pointer: "error" }],
    ["the blob is gone", { pointer: { ref: PRIOR_REF } }],
  ];
  for (const [why, init] of cases) {
    const h = install({ ...init, registrations: [registration("s1", { chainId: MAINNET }), registration("e1", { chainId: MAINNET })] });
    await snap.rebuildSnapshot({ touchedEventIds: ["s2"] });
    assert.equal(h.written.length, 1, why);
    assert.equal(h.registrationReads, 1, why);
    assert.deepEqual(ids(h.last().cards), ["e1", "s1", "s2"], why);
  }
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

test("a rebuild that changes nothing writes nothing", async () => {
  const h = install({ pointer: "absent", registrations: [registration("cur1", { chainId: MAINNET })] });
  await snap.rebuildSnapshot({ full: true });
  await snap.rebuildSnapshot({ full: true });
  await snap.rebuildSnapshot({ touchedEventIds: ["cur1"] });
  assert.equal(h.written.length, 1);
});
