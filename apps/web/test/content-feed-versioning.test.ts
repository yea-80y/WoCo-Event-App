/**
 * Versioned content-feed rail (fix for the SOC-overwrite silent no-op, 2026-07-04).
 *
 * A SOC is immutable, so the old fixed-identifier scheme only ever landed the FIRST
 * write and silently discarded every edit. These tests exercise the shared
 * probing-read core against an in-memory chunk store that models Bee's IMMUTABLE
 * semantics (first write at an address wins; later writes are no-ops), proving:
 *   - overwrite round-trip: v0 then v1 both land and "latest" advances;
 *   - legacy fallback: a pre-versioning fixed-identifier chunk stays readable;
 *   - and once v0 exists it wins over the legacy chunk (old events become editable);
 *   - multi-chunk reassembly is VERSION-SCOPED (no torn read across versions);
 *   - resolveLatestSocVersion walks past the parallel probe window (>8 versions).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  contentFeedSocIdentifier,
  contentFeedPageTopic,
  versionedSocIdentifier,
  versionedPageIdentifier,
  beeFeedUpdateIdentifier,
  resolveLatestSocVersion,
  readVersionedContentFeed,
  LEGACY_CONTENT_FEED_VERSION,
  CONTENT_FEED_MC_MARKER,
  SOC_MAX_PAYLOAD_SIZE,
  type SocChunkReader,
} from "@woco/shared";

const enc = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** In-memory chunk store with Bee's IMMUTABLE write semantics (first write wins). */
function makeStore() {
  const map = new Map<string, Uint8Array>();
  const putImmutable = (id: Uint8Array, payload: Uint8Array) => {
    const k = hex(id);
    if (!map.has(k)) map.set(k, payload); // dedupe-by-address: later writes discarded
  };
  const read: SocChunkReader = async (id) => map.get(hex(id)) ?? null;
  return { map, putImmutable, read };
}

/** Model of the client writer: resolve latest, write version n+1 (single-chunk). */
async function writeVersion(store: ReturnType<typeof makeStore>, topic: string, json: string) {
  const base = contentFeedSocIdentifier(topic);
  const latest = await resolveLatestSocVersion(store.read, (v) => versionedSocIdentifier(base, v));
  const version = (latest ?? LEGACY_CONTENT_FEED_VERSION) + 1;
  store.putImmutable(versionedSocIdentifier(base, version), enc(json));
  return version;
}

test("versionedSocIdentifier(keccak(topic), n) === beeFeedUpdateIdentifier(topic, n)", () => {
  for (const topic of ["woco/event/abc", "woco/profile/data/0xdead", "x"]) {
    for (const n of [0, 1, 7, 8, 9, 1000]) {
      assert.equal(
        hex(versionedSocIdentifier(contentFeedSocIdentifier(topic), n)),
        hex(beeFeedUpdateIdentifier(topic, n)),
        `mismatch topic=${topic} n=${n}`,
      );
    }
  }
});

test("page identifiers never collide with the base or across versions/pages", () => {
  const base = contentFeedSocIdentifier("woco/event/collide");
  const seen = new Set<string>();
  for (let v = 0; v < 4; v++) {
    seen.add(hex(versionedSocIdentifier(base, v)));
    for (let p = 1; p <= 4; p++) seen.add(hex(versionedPageIdentifier(base, v, p)));
  }
  assert.equal(seen.size, 4 + 4 * 4, "identifiers must all be distinct");
});

test("overwrite round-trip: v0 then v1 both land, latest advances", async () => {
  const store = makeStore();
  const topic = "woco/event/round-trip";

  assert.equal(await writeVersion(store, topic, JSON.stringify({ n: 0 })), 0);
  let res = await readVersionedContentFeed(store.read, topic);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(res!.bytes)), { n: 0 });
  assert.equal(res!.version, 0);

  assert.equal(await writeVersion(store, topic, JSON.stringify({ n: 1 })), 1);
  res = await readVersionedContentFeed(store.read, topic);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(res!.bytes)), { n: 1 });
  assert.equal(res!.version, 1);

  // A third edit — the whole point is that this is NOT silently discarded.
  assert.equal(await writeVersion(store, topic, JSON.stringify({ n: 2 })), 2);
  res = await readVersionedContentFeed(store.read, topic);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(res!.bytes)), { n: 2 });
});

test("legacy fallback: pre-versioning fixed-identifier chunk stays readable, then v0 wins", async () => {
  const store = makeStore();
  const topic = "woco/event/legacy";

  // A feed written before this fix lives ONLY at the legacy fixed identifier.
  store.putImmutable(contentFeedSocIdentifier(topic), enc(JSON.stringify({ old: true })));
  let res = await readVersionedContentFeed(store.read, topic);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(res!.bytes)), { old: true });
  assert.equal(res!.version, LEGACY_CONTENT_FEED_VERSION);

  // Its first edit writes version 0, which then supersedes the legacy chunk with
  // NO re-publish — i.e. old events become editable.
  const v = await writeVersion(store, topic, JSON.stringify({ old: false }));
  assert.equal(v, 0, "first edit of a legacy feed writes version 0");
  res = await readVersionedContentFeed(store.read, topic);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(res!.bytes)), { old: false });
  assert.equal(res!.version, 0);
});

test("multi-chunk reassembly is version-scoped (no torn read across versions)", async () => {
  const store = makeStore();
  const topic = "woco/event/paged";
  const base = contentFeedSocIdentifier(topic);

  // Version 0: a 2-page payload "AAAA…" / "BBBB…".
  const pageBytes = SOC_MAX_PAYLOAD_SIZE;
  const v0a = "A".repeat(pageBytes);
  const v0b = "B".repeat(10);
  store.putImmutable(versionedPageIdentifier(base, 0, 1), enc(v0a));
  store.putImmutable(versionedPageIdentifier(base, 0, 2), enc(v0b));
  store.putImmutable(
    versionedSocIdentifier(base, 0),
    enc(JSON.stringify({ [CONTENT_FEED_MC_MARKER]: 1, pages: 2, len: v0a.length + v0b.length })),
  );

  // Version 1: a DIFFERENT 1-page payload. Its page id is version-scoped, so it can
  // never be mistaken for v0's pages.
  const v1 = JSON.stringify({ edited: true });
  store.putImmutable(versionedSocIdentifier(base, 1), enc(v1));

  const res = await readVersionedContentFeed(store.read, topic);
  assert.equal(res!.version, 1);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(res!.bytes)), { edited: true });

  // v0's assembled body is exactly its two pages concatenated (sanity on the pager).
  store.map.delete(hex(versionedSocIdentifier(base, 1))); // drop v1 → latest is v0
  const res0 = await readVersionedContentFeed(store.read, topic);
  assert.equal(res0!.version, 0);
  assert.equal(new TextDecoder().decode(res0!.bytes), v0a + v0b);
});

test("resolveLatestSocVersion walks past the parallel probe window", async () => {
  const store = makeStore();
  const topic = "woco/event/deep";
  const base = contentFeedSocIdentifier(topic);
  // 20 contiguous versions (> the internal window of 8) then a gap.
  for (let v = 0; v <= 20; v++) store.putImmutable(versionedSocIdentifier(base, v), enc(String(v)));
  const latest = await resolveLatestSocVersion(store.read, (v) => versionedSocIdentifier(base, v));
  assert.equal(latest, 20);

  // A valid hint skips ahead; a stale-high hint (past the end) falls back to a scan.
  assert.equal(await resolveLatestSocVersion(store.read, (v) => versionedSocIdentifier(base, v), 15), 20);
  assert.equal(await resolveLatestSocVersion(store.read, (v) => versionedSocIdentifier(base, v), 999), 20);
});

test("empty feed resolves to null (→ caller treats as not-found)", async () => {
  const store = makeStore();
  assert.equal(await readVersionedContentFeed(store.read, "woco/event/none"), null);
  assert.equal(
    await resolveLatestSocVersion(store.read, (v) =>
      versionedSocIdentifier(contentFeedSocIdentifier("woco/event/none"), v)),
    null,
  );
});
