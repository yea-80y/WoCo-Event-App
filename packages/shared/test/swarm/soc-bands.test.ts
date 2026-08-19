import test from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  resolveBandedHead,
  resolveOpenBand,
  resolveLatestSocVersion,
  contentFeedSocIdentifier,
  versionedSocIdentifier,
  type SocChunkProbe,
} from "../../src/swarm/soc.js";
import { STATEMENT_BAND_SIZE } from "../../src/statement/discipline.js";

/** Where the head is, without the hint diagnostics. Those are asserted in their
 *  own tests; pinning the whole shape here would make every unrelated test fail
 *  whenever an instrument is added — which is how the last instrument regression
 *  went unnoticed. */
function where(r: { band: number; latest: number | null; clean: boolean }) {
  return { band: r.band, latest: r.latest, clean: r.clean };
}


const topicForBand = (band: number): string => `woco/test/v1/band-${band}`;

/**
 * A fake feed built from `bandFill` — entry i is how many versions band i holds.
 * Counts probes so the COST claims in the design record are asserted, not argued:
 * a probe past the end is a bee network search for a chunk that does not exist,
 * which is the expensive unit this whole scheme exists to bound.
 */
function fakeFeed(bandFill: number[], opts: { unavailableAt?: string } = {}) {
  const present = new Set<string>();
  bandFill.forEach((count, band) => {
    const base = contentFeedSocIdentifier(topicForBand(band));
    for (let v = 0; v < count; v++) present.add(bytesToHex(versionedSocIdentifier(base, v)));
  });
  let probes = 0;
  let misses = 0;
  const read: SocChunkProbe = async (id) => {
    probes++;
    const hex = bytesToHex(id);
    if (opts.unavailableAt === hex) return { status: "unavailable", reason: "test" };
    if (present.has(hex)) return { status: "found", bytes: new Uint8Array([1]) };
    misses++;
    return { status: "absent" };
  };
  return { read, stats: () => ({ probes, misses }) };
}

const FULL = STATEMENT_BAND_SIZE;

test("a feed that does not exist resolves to band 0 / null, in one probe", async () => {
  const f = fakeFeed([]);
  assert.deepEqual(where(await resolveBandedHead(f.read, topicForBand)), { band: 0, latest: null, clean: true });
  // One probe window, not one probe: scanning first asks versions 0 and 1 together.
  assert.ok(f.stats().probes <= 2, `expected <= 2 probes, got ${f.stats().probes}`);
});

test("a partially filled band 0 resolves inside band 0", async () => {
  const f = fakeFeed([10]);
  const r = await resolveBandedHead(f.read, topicForBand);
  assert.deepEqual({ band: r.band, latest: r.latest }, { band: 0, latest: 9 });
  assert.equal(r.clean, true);
});

test("an exactly-full band 0 with nothing after it stays in band 0", async () => {
  // The boundary the full-band invariant exists to make unambiguous: band 0 is
  // full, band 1 has not been opened, so the head is the last slot of band 0.
  const f = fakeFeed([FULL]);
  const r = await resolveBandedHead(f.read, topicForBand);
  assert.deepEqual({ band: r.band, latest: r.latest }, { band: 0, latest: FULL - 1 });
});

test("once a later band is opened, the head is found there", async () => {
  const f = fakeFeed([FULL, FULL, 5]);
  const r = await resolveBandedHead(f.read, topicForBand);
  assert.deepEqual({ band: r.band, latest: r.latest }, { band: 2, latest: 4 });
});

test("a correct band hint skips the opener walk", async () => {
  const cold = fakeFeed([FULL, FULL, FULL, FULL, 3]);
  const coldResult = await resolveBandedHead(cold.read, topicForBand);
  const warm = fakeFeed([FULL, FULL, FULL, FULL, 3]);
  const warmResult = await resolveBandedHead(warm.read, topicForBand, 4);

  // Same HEAD either way; the hint diagnostics deliberately differ, which is the
  // whole point of the instrument.
  assert.deepEqual(where(coldResult), where(warmResult));
  assert.ok(
    warm.stats().probes < cold.stats().probes,
    `hinted read (${warm.stats().probes}) should cost less than cold (${cold.stats().probes})`,
  );
});

test("a hint past the end falls back to a full walk and still lands correctly", async () => {
  // Exactly the stale-hint case: the hinted band was never opened. Cost, not
  // correctness — the walk restarts from 0 and finds the real head.
  const f = fakeFeed([FULL, 7]);
  const r = await resolveBandedHead(f.read, topicForBand, 99);
  assert.deepEqual({ band: r.band, latest: r.latest, clean: r.clean }, { band: 1, latest: 6, clean: true });
});

test("cost is O(bands + band size), not O(bands x band size)", async () => {
  // The reason the opener walk and the in-band scan are separate phases.
  // Resolving each band in turn would cost ~bands * (band size / window).
  const bands = 8;
  const f = fakeFeed([...Array<number>(bands).fill(FULL), 4]);
  const r = await resolveBandedHead(f.read, topicForBand);
  assert.equal(r.band, bands);

  // Walking up costs a LAST-SLOT probe plus an opener probe per full band, and
  // one in-band scan at the end — not a scan per band, which is the quadratic
  // shape this asserts against.
  const quadratic = bands * FULL;
  assert.ok(
    f.stats().probes < quadratic / 2,
    `expected well under ${quadratic} probes, got ${f.stats().probes}`,
  );
  // The expensive unit specifically: absent-chunk searches stay a small constant
  // however many bands exist.
  assert.ok(f.stats().misses <= 4, `misses should stay O(1), got ${f.stats().misses}`);
});

test("an inconclusive probe clears `clean` so a writer can refuse", async () => {
  // A dirty scan cannot bound the sequence: the version it failed to read may
  // exist, and a write there is silently deduped and LOST. Writers check this.
  const base = contentFeedSocIdentifier(topicForBand(0));
  const f = fakeFeed([10], { unavailableAt: bytesToHex(versionedSocIdentifier(base, 10)) });
  const r = await resolveBandedHead(f.read, topicForBand);
  assert.equal(r.clean, false);
});

test("a topic family that ignores its band is REFUSED, not walked forever", async () => {
  // The bug this guards shipped for one review cycle and would have hung the
  // production social indexer on the first like it tried to tally. A pinned
  // family returns the same topic for every band, so every opener probe hits the
  // SAME chunk; if it exists, no opener is ever absent and the walk cannot end.
  // Proven at the time with a bounded probe: 201 probes and still advancing.
  const f = fakeFeed([1]);
  await assert.rejects(
    () => resolveOpenBand(f.read, () => "woco/like/v1/pinned"),
    /varies with band/,
    "a constant family must fail loudly rather than loop",
  );
});

test("a family that varies is accepted, so the tripwire cannot block real use", async () => {
  const f = fakeFeed([FULL, 2]);
  const r = await resolveOpenBand(f.read, topicForBand);
  assert.deepEqual({ band: r.band, exists: r.exists }, { band: 1, exists: true });
});

// ── Scan-first: the cost claim, measured rather than argued ──────────────────

test("an exact hint mid-band costs ZERO opener probes", async () => {
  // The whole point of scanning before walking. Under the full-band invariant a
  // band that is not full proves no higher band was ever opened, so the head is
  // already in hand and no opener is worth a probe. This is the warm path.
  const f = fakeFeed([FULL, FULL, 10]);
  const r = await resolveBandedHead(f.read, topicForBand, 2);
  assert.deepEqual({ band: r.band, latest: r.latest, clean: r.clean }, { band: 2, latest: 9, clean: true });
  // 10 versions => scan probes 0..9 as hits plus one terminal window of misses.
  assert.ok(f.stats().misses <= 2, `expected <= 2 misses, got ${f.stats().misses}`);
});

test("a band boundary costs exactly one extra opener miss", async () => {
  const f = fakeFeed([FULL]);
  const r = await resolveBandedHead(f.read, topicForBand, 0);
  assert.deepEqual({ band: r.band, latest: r.latest }, { band: 0, latest: FULL - 1 });
});

test("a hint above the open band restarts from the bottom and still lands", async () => {
  const f = fakeFeed([FULL, 3]);
  const r = await resolveBandedHead(f.read, topicForBand, 99);
  assert.deepEqual({ band: r.band, latest: r.latest, clean: r.clean }, { band: 1, latest: 2, clean: true });
});

test("a pinned family is refused here too, not just in the opener walk", async () => {
  const f = fakeFeed([1]);
  await assert.rejects(() => resolveBandedHead(f.read, () => "woco/like/v1/pinned"), /varies with band/);
});

test("COLD multi-band: scan-first must not cost more MISSES than the opener walk", async () => {
  // The regression this ordering could have introduced. Walking up from a cold
  // hint scans each full band on the way, so the cheap-hit count rises — what
  // must NOT rise is the count of missing-chunk searches, which is the unit that
  // costs seconds and melts the node.
  const layout = [FULL, FULL, FULL, FULL, FULL, 5];

  const scanFirst = fakeFeed(layout);
  const a = await resolveBandedHead(scanFirst.read, topicForBand, 0);
  assert.deepEqual({ band: a.band, latest: a.latest }, { band: 5, latest: 4 });

  const walkFirst = fakeFeed(layout);
  const open = await resolveOpenBand(walkFirst.read, topicForBand, 0);
  const base = contentFeedSocIdentifier(topicForBand(open.band));
  await resolveLatestSocVersion(walkFirst.read, (v) => versionedSocIdentifier(base, v), 0);

  assert.ok(
    scanFirst.stats().misses <= walkFirst.stats().misses,
    `scan-first misses (${scanFirst.stats().misses}) must not exceed walk-first (${walkFirst.stats().misses})`,
  );
  // Reported so a regression in the CHEAP unit is visible rather than silent.
  console.info(
    `[bands] cold 6-band — scan-first ${scanFirst.stats().probes} probes / ${scanFirst.stats().misses} miss` +
      ` · walk-first ${walkFirst.stats().probes} probes / ${walkFirst.stats().misses} miss`,
  );
});

test("an UNBANDED feed still resolves past the band ceiling", async () => {
  // The finding-6 interaction, asserted rather than assumed. Pinned types —
  // likes and follows — legally exceed STATEMENT_BAND_SIZE versions in band 0,
  // because their writer never opens a band. The ceiling belongs ONLY to banded
  // scans; applying it to a pinned feed would silently cap its head at version
  // 63 and lose every toggle after it.
  const base = contentFeedSocIdentifier("woco/like/v1/pinned-subject");
  const present = new Set<string>();
  for (let v = 0; v <= FULL + 10; v++) present.add(bytesToHex(versionedSocIdentifier(base, v)));
  const read: SocChunkProbe = async (id) =>
    present.has(bytesToHex(id)) ? { status: "found", bytes: new Uint8Array([1]) } : { status: "absent" };

  const r = await resolveLatestSocVersion(read, (v) => versionedSocIdentifier(base, v));
  assert.equal(r.latest, FULL + 10, "no ceiling without one being asked for");
});

test("a banded scan stops AT the last slot and probes nothing above it", async () => {
  // Versions above the last slot cannot exist in a banded feed — the writer
  // opens the next band instead — so probing for them is a missing-chunk search
  // for an address the scheme guarantees is empty, on every full-band scan.
  const f = fakeFeed([FULL]);
  const r = await resolveBandedHead(f.read, topicForBand, 0);
  assert.equal(r.latest, FULL - 1);
  assert.equal(f.stats().misses, 1, "only the next band's opener may miss");
});

// ── The hint instrument, on the banded path ─────────────────────────────────

test("a cold banded read reports NO hint, not a used one", async () => {
  const f = fakeFeed([5]);
  const r = await resolveBandedHead(f.read, topicForBand, 0);
  assert.equal(r.hintGiven, false);
  assert.equal(r.hintInvalidated, false);
});

test("a stale VERSION hint is reported as INVALIDATED, not as used", async () => {
  // The alarm that must be able to fire. A version this device believes it wrote
  // reading as absent is the whitelist-lag pathology — and it is invisible in
  // `clean`, because an absent probe is a clean answer. Counting off `clean`
  // reported this as a healthy warm read.
  const f = fakeFeed([5]);
  const r = await resolveBandedHead(f.read, topicForBand, 0, () => 40);
  assert.equal(r.latest, 4, "the scan still lands correctly");
  assert.equal(r.clean, true, "and the probes were all definitive");
  assert.equal(r.hintGiven, true);
  assert.equal(r.hintInvalidated, true, "a hint that forced a rescan is the alarm");
});

test("a good version hint is reported as USED", async () => {
  const f = fakeFeed([20]);
  const r = await resolveBandedHead(f.read, topicForBand, 0, () => 15);
  assert.equal(r.latest, 19);
  assert.deepEqual({ given: r.hintGiven, bad: r.hintInvalidated }, { given: true, bad: false });
});

test("a BAND hint naming an unopened band is the same alarm", async () => {
  const f = fakeFeed([FULL, 3]);
  const r = await resolveBandedHead(f.read, topicForBand, 99);
  assert.equal(r.band, 1, "it still lands");
  assert.equal(r.hintInvalidated, true, "but the restart from zero is reported");
});
