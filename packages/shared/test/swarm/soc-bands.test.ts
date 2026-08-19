import test from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  resolveBandedHead,
  contentFeedSocIdentifier,
  versionedSocIdentifier,
  type SocChunkProbe,
} from "../../src/swarm/soc.js";
import { STATEMENT_BAND_SIZE } from "../../src/statement/discipline.js";

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
  assert.deepEqual(await resolveBandedHead(f.read, topicForBand), { band: 0, latest: null, clean: true });
  assert.equal(f.stats().probes, 1);
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

  assert.deepEqual(coldResult, warmResult);
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

  const quadratic = bands * (FULL / 2);
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
