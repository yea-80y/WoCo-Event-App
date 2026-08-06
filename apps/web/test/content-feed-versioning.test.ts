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
 *
 * Plus the tri-state read contract (#138/#154/#155): a probe that CANNOT ANSWER
 * must never be reported as "absent", because a writer computes the next version
 * off that answer and a login caches "never recovered" off it.
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
  type SocChunkProbe,
} from "@woco/shared";

const enc = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * In-memory chunk store with Bee's IMMUTABLE write semantics (first write wins).
 * `blackhole` models a chunk the network cannot answer for (403 whitelist lag,
 * 5xx, error page) as distinct from one that isn't there.
 */
function makeStore() {
  const map = new Map<string, Uint8Array>();
  const blackhole = new Set<string>();
  const putImmutable = (id: Uint8Array, payload: Uint8Array) => {
    const k = hex(id);
    if (!map.has(k)) map.set(k, payload); // dedupe-by-address: later writes discarded
  };
  const read: SocChunkProbe = async (id) => {
    const k = hex(id);
    if (blackhole.has(k)) return { status: "unavailable", reason: "test blackhole" };
    const bytes = map.get(k);
    return bytes ? { status: "found", bytes } : { status: "absent" };
  };
  /** Make the chunk at `id` unreadable-but-not-absent. */
  const hide = (id: Uint8Array) => blackhole.add(hex(id));
  return { map, putImmutable, read, hide };
}

/** Model of the client writer: resolve latest, write version n+1 (single-chunk). */
async function writeVersion(store: ReturnType<typeof makeStore>, topic: string, json: string) {
  const base = contentFeedSocIdentifier(topic);
  const { latest, clean } = await resolveLatestSocVersion(store.read, (v) => versionedSocIdentifier(base, v));
  if (!clean) throw new Error("inconclusive probe — writer must refuse");
  const version = (latest ?? LEGACY_CONTENT_FEED_VERSION) + 1;
  store.putImmutable(versionedSocIdentifier(base, version), enc(json));
  return version;
}

/** Assert a feed read FOUND something and hand back the found branch. */
function found(res: Awaited<ReturnType<typeof readVersionedContentFeed>>) {
  assert.equal(res.status, "found");
  return res as Extract<typeof res, { status: "found" }>;
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
  let res = found(await readVersionedContentFeed(store.read, topic));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(res.bytes)), { n: 0 });
  assert.equal(res.version, 0);

  assert.equal(await writeVersion(store, topic, JSON.stringify({ n: 1 })), 1);
  res = found(await readVersionedContentFeed(store.read, topic));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(res.bytes)), { n: 1 });
  assert.equal(res.version, 1);

  // A third edit — the whole point is that this is NOT silently discarded.
  assert.equal(await writeVersion(store, topic, JSON.stringify({ n: 2 })), 2);
  res = found(await readVersionedContentFeed(store.read, topic));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(res.bytes)), { n: 2 });
});

test("legacy fallback: pre-versioning fixed-identifier chunk stays readable, then v0 wins", async () => {
  const store = makeStore();
  const topic = "woco/event/legacy";

  // A feed written before this fix lives ONLY at the legacy fixed identifier.
  store.putImmutable(contentFeedSocIdentifier(topic), enc(JSON.stringify({ old: true })));
  let res = found(await readVersionedContentFeed(store.read, topic));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(res.bytes)), { old: true });
  assert.equal(res.version, LEGACY_CONTENT_FEED_VERSION);

  // Its first edit writes version 0, which then supersedes the legacy chunk with
  // NO re-publish — i.e. old events become editable.
  const v = await writeVersion(store, topic, JSON.stringify({ old: false }));
  assert.equal(v, 0, "first edit of a legacy feed writes version 0");
  res = found(await readVersionedContentFeed(store.read, topic));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(res.bytes)), { old: false });
  assert.equal(res.version, 0);
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

  const res = found(await readVersionedContentFeed(store.read, topic));
  assert.equal(res.version, 1);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(res.bytes)), { edited: true });

  // v0's assembled body is exactly its two pages concatenated (sanity on the pager).
  store.map.delete(hex(versionedSocIdentifier(base, 1))); // drop v1 → latest is v0
  const res0 = found(await readVersionedContentFeed(store.read, topic));
  assert.equal(res0.version, 0);
  assert.equal(new TextDecoder().decode(res0.bytes), v0a + v0b);
});

test("resolveLatestSocVersion walks past the parallel probe window", async () => {
  const store = makeStore();
  const topic = "woco/event/deep";
  const base = contentFeedSocIdentifier(topic);
  // 20 contiguous versions (> the internal window of 8) then a gap.
  for (let v = 0; v <= 20; v++) store.putImmutable(versionedSocIdentifier(base, v), enc(String(v)));
  const idFor = (v: number) => versionedSocIdentifier(base, v);
  assert.deepEqual(await resolveLatestSocVersion(store.read, idFor), { latest: 20, clean: true });

  // A valid hint skips ahead; a stale-high hint (past the end) falls back to a scan.
  assert.deepEqual(await resolveLatestSocVersion(store.read, idFor, 15), { latest: 20, clean: true });
  assert.deepEqual(await resolveLatestSocVersion(store.read, idFor, 999), { latest: 20, clean: true });
});

test("empty feed resolves to absent (→ the one negative a caller may cache)", async () => {
  const store = makeStore();
  const topic = "woco/event/none";
  assert.deepEqual(await readVersionedContentFeed(store.read, topic), { status: "absent" });
  assert.deepEqual(
    await resolveLatestSocVersion(store.read, (v) =>
      versionedSocIdentifier(contentFeedSocIdentifier(topic), v)),
    { latest: null, clean: true },
  );
});

// ---------------------------------------------------------------------------
// Tri-state contract (#138 / #154 / #155)
// ---------------------------------------------------------------------------

test("an unanswerable probe clears `clean` — the writer must not target latest+1", async () => {
  const store = makeStore();
  const topic = "woco/event/blackhole";
  const base = contentFeedSocIdentifier(topic);

  // v0 and v1 exist; v1 is unreadable (403/5xx), so the scan stops at v0.
  store.putImmutable(versionedSocIdentifier(base, 0), enc(JSON.stringify({ n: 0 })));
  store.putImmutable(versionedSocIdentifier(base, 1), enc(JSON.stringify({ n: 1 })));
  store.hide(versionedSocIdentifier(base, 1));

  const res = await resolveLatestSocVersion(store.read, (v) => versionedSocIdentifier(base, v));
  assert.equal(res.latest, 0, "latest is a lower bound, not the truth");
  assert.equal(res.clean, false, "the scan did not get every answer");

  // Writing v1 here is the silent-loss bug: the chunk exists, bee dedupes by
  // address, 201 comes back and the OLD payload stays. The writer refuses instead.
  await assert.rejects(() => writeVersion(store, topic, JSON.stringify({ n: 2 })), /inconclusive/);
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(store.map.get(hex(versionedSocIdentifier(base, 1)))!)),
    { n: 1 },
    "v1 must still hold its original payload",
  );
});

test("an unreadable feed reads as unavailable, never absent", async () => {
  const store = makeStore();
  const topic = "woco/event/unreadable";
  const base = contentFeedSocIdentifier(topic);

  // Nothing is readable at all — including the legacy identifier, which must NOT
  // be consulted for a verdict after a dirty scan.
  store.putImmutable(versionedSocIdentifier(base, 0), enc(JSON.stringify({ n: 0 })));
  store.hide(versionedSocIdentifier(base, 0));

  const res = await readVersionedContentFeed(store.read, topic);
  assert.equal(res.status, "unavailable");
});

test("a retry that dedupes against a failed attempt's pages is caught by `len`", async () => {
  const store = makeStore();
  const topic = "woco/site/config/retry";
  const base = contentFeedSocIdentifier(topic);

  // Attempt 1 at version 0: pages land, then the manifest upload FAILS. Version 0
  // now has pages but no base chunk.
  const oldA = "O".repeat(SOC_MAX_PAYLOAD_SIZE);
  const oldB = "O".repeat(20);
  store.putImmutable(versionedPageIdentifier(base, 0, 1), enc(oldA));
  store.putImmutable(versionedPageIdentifier(base, 0, 2), enc(oldB));

  // Attempt 2. The probe of version 0 finds its base genuinely absent — a CLEAN
  // answer — so #154's refusal does not fire and cannot help here.
  const probe = await resolveLatestSocVersion(store.read, (v) => versionedSocIdentifier(base, v));
  assert.deepEqual(probe, { latest: null, clean: true }, "the torn version reads as a clean absence");

  // It targets version 0 again. Its page uploads DEDUPE against attempt 1's chunks
  // (immutable: old bytes kept), while the fresh manifest describes the new payload.
  const newA = "N".repeat(SOC_MAX_PAYLOAD_SIZE);
  const newB = "N".repeat(50);
  store.putImmutable(versionedPageIdentifier(base, 0, 1), enc(newA)); // no-op
  store.putImmutable(versionedPageIdentifier(base, 0, 2), enc(newB)); // no-op
  store.putImmutable(
    versionedSocIdentifier(base, 0),
    enc(JSON.stringify({ [CONTENT_FEED_MC_MARKER]: 1, pages: 2, len: newA.length + newB.length })),
  );

  // Without the length check this serves attempt 1's payload as the new version,
  // silently. `len` is the only field that disagrees.
  const res = await readVersionedContentFeed(store.read, topic);
  assert.equal(res.status, "unavailable", "stale pages under a fresh manifest must not read as found");

  // And an honestly-written feed of the same shape still reads fine.
  const clean = makeStore();
  clean.putImmutable(versionedPageIdentifier(base, 0, 1), enc(newA));
  clean.putImmutable(versionedPageIdentifier(base, 0, 2), enc(newB));
  clean.putImmutable(
    versionedSocIdentifier(base, 0),
    enc(JSON.stringify({ [CONTENT_FEED_MC_MARKER]: 1, pages: 2, len: newA.length + newB.length })),
  );
  assert.equal(new TextDecoder().decode(found(await readVersionedContentFeed(clean.read, topic)).bytes), newA + newB);
});

test("a torn multi-chunk feed is unavailable, not absent", async () => {
  const store = makeStore();
  const topic = "woco/event/torn";
  const base = contentFeedSocIdentifier(topic);

  // A manifest promising 2 pages, with page 2 missing — real bytes are at this
  // identifier, so "absent" would be a lie a caller could cache.
  store.putImmutable(versionedPageIdentifier(base, 0, 1), enc("A"));
  store.putImmutable(
    versionedSocIdentifier(base, 0),
    enc(JSON.stringify({ [CONTENT_FEED_MC_MARKER]: 1, pages: 2, len: 2 })),
  );

  const res = await readVersionedContentFeed(store.read, topic);
  assert.equal(res.status, "unavailable");
});
