/**
 * Feed-topic derivation (#197).
 *
 * These strings ARE the feed addresses — `topics.ts` says so at the top. So the
 * format pins below are not style checks: an accidental reformat silently moves
 * every feed and the old data becomes unreachable.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Topic } from "@ethersphere/bee-js";
import {
  topicClaims,
  topicClaimers,
  topicPendingClaims,
  topicEditions,
  topicEventDirectory,
  topicUserCollection,
  isValidSeriesId,
} from "../src/lib/swarm/topics.js";

const SERIES = "abc-1234";
const hex = (t: Topic) => t.toHex();

describe("paged topic format — byte-exact pins", () => {
  it("page 0 is the bare base topic, with no suffix", () => {
    assert.equal(hex(topicClaims(SERIES, 0)), hex(Topic.fromString("woco/pod/claims/abc-1234")));
    assert.equal(hex(topicClaimers(SERIES, 0)), hex(Topic.fromString("woco/pod/claimers/abc-1234")));
    assert.equal(
      hex(topicPendingClaims(SERIES, 0)),
      hex(Topic.fromString("woco/pod/pending-claims/abc-1234")),
    );
    assert.equal(hex(topicEditions(SERIES, 0)), hex(Topic.fromString("woco/pod/editions/abc-1234")));
  });

  it("pages 1+ append /p{N}", () => {
    assert.equal(hex(topicClaims(SERIES, 3)), hex(Topic.fromString("woco/pod/claims/abc-1234/p3")));
    assert.equal(
      hex(topicPendingClaims(SERIES, 12)),
      hex(Topic.fromString("woco/pod/pending-claims/abc-1234/p12")),
    );
  });

  it("page 0 defaults, so a pre-paging feed IS page 0", () => {
    assert.equal(hex(topicClaims(SERIES)), hex(topicClaims(SERIES, 0)));
    assert.equal(hex(topicEventDirectory()), hex(topicEventDirectory(0)));
  });
});

describe("the collision #197 reported is now unrepresentable", () => {
  it("rejects a series id carrying the page separator", () => {
    // Before the guard: topicClaims("abc/p1", 0) === topicClaims("abc", 1).
    assert.throws(() => topicClaims("abc/p1", 0), /Invalid feed topic seriesId/);
    assert.throws(() => topicClaimers("abc/p1", 0), /Invalid feed topic seriesId/);
    assert.throws(() => topicPendingClaims("abc/p1", 0), /Invalid feed topic seriesId/);
    assert.throws(() => topicEditions("abc/p1", 0), /Invalid feed topic seriesId/);
  });

  it("no series id can collide with another series' page", () => {
    // The invariant: a 2-segment path cannot equal a 3-segment one while no
    // component holds a "/". Spot-check the shape that used to break.
    assert.notEqual(hex(topicClaims("abc-9999", 1)), hex(topicClaims("abc-9998", 0)));
  });

  it("rejects uppercase — two byte forms of one logical id", () => {
    assert.throws(() => topicClaims("ABC-1234", 0), /Invalid feed topic seriesId/);
  });

  it("rejects an empty component rather than building a blank segment", () => {
    assert.throws(() => topicClaims("", 0), /Invalid feed topic seriesId/);
  });

  it("rejects a non-integer or negative page", () => {
    assert.throws(() => topicClaims(SERIES, 1.5), /Invalid feed topic page/);
    assert.throws(() => topicClaims(SERIES, -1), /Invalid feed topic page/);
    assert.throws(() => topicClaims(SERIES, NaN), /Invalid feed topic page/);
  });

  it("guards address-keyed paged topics too", () => {
    assert.throws(() => topicUserCollection("0xabc/p1", 0), /Invalid feed topic ethAddress/);
  });

  it("accepts a lowercased eth address", () => {
    const addr = "0x24f5765a4c7c002e9fec82f8b559ef71cd6b1e82";
    assert.equal(
      hex(topicUserCollection(addr, 0)),
      hex(Topic.fromString(`woco/pod/collection/${addr}`)),
    );
  });
});

describe("isValidSeriesId — the creation-time gate", () => {
  it("accepts what the client actually mints", () => {
    // Both mint sites call crypto.randomUUID(); pin that it passes.
    for (let i = 0; i < 20; i++) {
      assert.ok(isValidSeriesId(crypto.randomUUID()), "randomUUID must pass");
    }
  });

  it("accepts a plain lowercase slug", () => {
    assert.ok(isValidSeriesId("general-admission"));
  });

  it("rejects the shapes that reach across the page separator", () => {
    assert.equal(isValidSeriesId("abc/p1"), false);
    assert.equal(isValidSeriesId("abc.p1"), false);
    assert.equal(isValidSeriesId("abc p1"), false);
  });

  it("rejects uppercase, empty, too short and too long", () => {
    assert.equal(isValidSeriesId("General-Admission"), false);
    assert.equal(isValidSeriesId(""), false);
    assert.equal(isValidSeriesId("short"), false);
    assert.equal(isValidSeriesId("a".repeat(65)), false);
  });

  it("rejects non-strings without throwing", () => {
    assert.equal(isValidSeriesId(undefined), false);
    assert.equal(isValidSeriesId(null), false);
    assert.equal(isValidSeriesId(12345678), false);
  });
});
