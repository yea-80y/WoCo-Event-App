/**
 * `unusableAt` — the line between "come back later" and "this will never read" (#190).
 *
 * Every failure below arrives as `unavailable`, and a caller holding a
 * read-modify-write on the feed cannot tell them apart from the status alone. It
 * has to: a version that exists and can never assemble freezes the feed forever
 * (the mutator refuses, correctly, on every attempt), while a probe nobody
 * answered is an ordinary fault that clears itself. The first earns a repair
 * offer; the second must never get one, because repairing means overwriting a
 * whole object we did not read.
 *
 * So the contract under test is symmetric, and BOTH halves matter: the three
 * definitive cases MUST name their version, and the inconclusive ones MUST NOT.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  assembleContentFeed,
  contentFeedSocIdentifier,
  contentFeedPageTopic,
  versionedSocIdentifier,
  versionedPageIdentifier,
  readVersionedContentFeed,
  CONTENT_FEED_MC_MARKER,
  LEGACY_CONTENT_FEED_VERSION,
  type SocChunkProbe,
} from "../../src/swarm/soc.js";

const TOPIC = "woco/test/unusable/v1";
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const enc = (s: string) => new TextEncoder().encode(s);

/** Chunk store with the three probe states Bee actually has. */
function makeStore() {
  const map = new Map<string, Uint8Array>();
  const blackhole = new Set<string>();
  const read: SocChunkProbe = async (id) => {
    const k = hex(id);
    if (blackhole.has(k)) return { status: "unavailable", reason: "test blackhole" };
    const bytes = map.get(k);
    return bytes ? { status: "found", bytes } : { status: "absent" };
  };
  return {
    read,
    put: (id: Uint8Array, payload: Uint8Array) => map.set(hex(id), payload),
    del: (id: Uint8Array) => map.delete(hex(id)),
    hide: (id: Uint8Array) => blackhole.add(hex(id)),
  };
}

const mcManifest = (pages: number, len: number) =>
  enc(JSON.stringify({ [CONTENT_FEED_MC_MARKER]: 1, pages, len }));

/** A multi-chunk version 0 whose pages hold `pageBytes`, declaring `len`. */
function writeMultiChunk(
  store: ReturnType<typeof makeStore>,
  version: number,
  pages: string[],
  declaredLen: number,
) {
  const base = contentFeedSocIdentifier(TOPIC);
  pages.forEach((p, i) => store.put(versionedPageIdentifier(base, version, i + 1), enc(p)));
  store.put(versionedSocIdentifier(base, version), mcManifest(pages.length, declaredLen));
}

// ── The three DEFINITIVE cases: `unusable` at the assembler, `unusableAt` above ──

test("page count out of range is unusable, and names its version", async () => {
  const store = makeStore();
  const base = contentFeedSocIdentifier(TOPIC);
  store.put(versionedSocIdentifier(base, 0), mcManifest(0, 10)); // pages < 1

  const asm = await assembleContentFeed(store.read, versionedSocIdentifier(base, 0), (p) =>
    versionedPageIdentifier(base, 0, p));
  assert.equal(asm.status, "unavailable");
  assert.equal(asm.status === "unavailable" && asm.unusable, true);

  const read = await readVersionedContentFeed(store.read, TOPIC);
  assert.equal(read.status, "unavailable");
  assert.equal(read.status === "unavailable" && read.unusableAt, 0);
});

test("an ABSENT page under an existing manifest is unusable (the torn write), and names its version", async () => {
  const store = makeStore();
  const base = contentFeedSocIdentifier(TOPIC);
  writeMultiChunk(store, 0, ["aaa", "bbb"], 6);
  store.del(versionedPageIdentifier(base, 0, 2)); // page 2 never landed

  const asm = await assembleContentFeed(store.read, versionedSocIdentifier(base, 0), (p) =>
    versionedPageIdentifier(base, 0, p));
  assert.equal(asm.status === "unavailable" && asm.unusable, true);

  const read = await readVersionedContentFeed(store.read, TOPIC);
  assert.equal(read.status === "unavailable" && read.unusableAt, 0);
});

test("a length mismatch is unusable, and names its version", async () => {
  const store = makeStore();
  writeMultiChunk(store, 0, ["aaa", "bbb"], 999); // assembles 6 B, declares 999

  const base = contentFeedSocIdentifier(TOPIC);
  const asm = await assembleContentFeed(store.read, versionedSocIdentifier(base, 0), (p) =>
    versionedPageIdentifier(base, 0, p));
  assert.equal(asm.status === "unavailable" && asm.unusable, true);

  const read = await readVersionedContentFeed(store.read, TOPIC);
  assert.equal(read.status === "unavailable" && read.unusableAt, 0);
});

test("the version named is the LATEST one, not 0", async () => {
  const store = makeStore();
  const base = contentFeedSocIdentifier(TOPIC);
  store.put(versionedSocIdentifier(base, 0), enc('{"ok":true}'));
  store.put(versionedSocIdentifier(base, 1), enc('{"ok":true}'));
  writeMultiChunk(store, 2, ["aaa"], 999);

  const read = await readVersionedContentFeed(store.read, TOPIC);
  assert.equal(read.status === "unavailable" && read.unusableAt, 2);
});

test("a legacy (pre-versioning) chunk that will not assemble is named by the legacy stamp", async () => {
  const store = makeStore();
  const base = contentFeedSocIdentifier(TOPIC);
  // Legacy layout: fixed base identifier + topic-string pages.
  store.put(contentFeedSocIdentifier(contentFeedPageTopic(TOPIC, 1)), enc("aaa"));
  store.put(base, mcManifest(1, 999));

  const read = await readVersionedContentFeed(store.read, TOPIC);
  assert.equal(read.status, "unavailable");
  assert.equal(read.status === "unavailable" && read.unusableAt, LEGACY_CONTENT_FEED_VERSION);
});

// ── The inconclusive cases: NOTHING may be named ────────────────────────────

test("a page the network could not ANSWER for is NOT unusable, and names no version", async () => {
  const store = makeStore();
  const base = contentFeedSocIdentifier(TOPIC);
  writeMultiChunk(store, 0, ["aaa", "bbb"], 6);
  store.hide(versionedPageIdentifier(base, 0, 2)); // present, unanswerable

  const asm = await assembleContentFeed(store.read, versionedSocIdentifier(base, 0), (p) =>
    versionedPageIdentifier(base, 0, p));
  assert.equal(asm.status, "unavailable");
  assert.equal(asm.status === "unavailable" && asm.unusable, undefined);

  const read = await readVersionedContentFeed(store.read, TOPIC);
  assert.equal(read.status, "unavailable");
  assert.equal(read.status === "unavailable" && read.unusableAt, undefined);
});

test("an inconclusive version PROBE names no version", async () => {
  const store = makeStore();
  const base = contentFeedSocIdentifier(TOPIC);
  store.hide(versionedSocIdentifier(base, 0)); // the scan cannot even start

  const read = await readVersionedContentFeed(store.read, TOPIC);
  assert.equal(read.status, "unavailable");
  assert.equal(read.status === "unavailable" && read.reason, "version probe inconclusive");
  assert.equal(read.status === "unavailable" && read.unusableAt, undefined);
});

test("a version that VANISHES between probe and read names no version", async () => {
  const store = makeStore();
  const base = contentFeedSocIdentifier(TOPIC);
  store.put(versionedSocIdentifier(base, 0), enc('{"ok":true}'));

  // A reader that answers `found` to the scan and `absent` to the re-read — the
  // self-contradiction the vanished branch exists for. It is NOT a verdict about
  // the bytes, so it must not be named.
  let seen = 0;
  const flaky: SocChunkProbe = async (id) => {
    const first = await store.read(id);
    if (first.status === "found" && seen++ > 0) return { status: "absent" };
    return first;
  };

  const read = await readVersionedContentFeed(flaky, TOPIC);
  assert.equal(read.status, "unavailable");
  assert.match(String(read.status === "unavailable" && read.reason), /vanished/);
  assert.equal(read.status === "unavailable" && read.unusableAt, undefined);
});
