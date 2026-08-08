/**
 * Feed-topic derivation (#197).
 *
 * These strings ARE the feed addresses — `topics.ts` says so at the top. So the
 * format pins below are not style checks: an accidental reformat silently moves
 * every feed and the old data becomes unreachable.
 *
 * (The v1 claim-rail topics — editions/claims/claimers/pending-claims — were
 * deleted with the rail; their pins went with them.)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Topic } from "@ethersphere/bee-js";
import {
  topicEventDirectory,
  topicUserCollection,
  topicCreatorDirectory,
  isValidSeriesId,
} from "../src/lib/swarm/topics.js";

const ADDR = "0x24f5765a4c7c002e9fec82f8b559ef71cd6b1e82";
const hex = (t: Topic) => t.toHex();

describe("paged topic format — byte-exact pins", () => {
  it("page 0 is the bare base topic, with no suffix", () => {
    assert.equal(
      hex(topicUserCollection(ADDR, 0)),
      hex(Topic.fromString(`woco/pod/collection/${ADDR}`)),
    );
    assert.equal(
      hex(topicCreatorDirectory(ADDR, 0)),
      hex(Topic.fromString(`woco/event/creator/${ADDR}`)),
    );
    assert.equal(hex(topicEventDirectory(0)), hex(Topic.fromString("woco/event/directory")));
  });

  it("pages 1+ append /p{N}", () => {
    assert.equal(
      hex(topicUserCollection(ADDR, 3)),
      hex(Topic.fromString(`woco/pod/collection/${ADDR}/p3`)),
    );
    assert.equal(
      hex(topicCreatorDirectory(ADDR, 12)),
      hex(Topic.fromString(`woco/event/creator/${ADDR}/p12`)),
    );
  });

  it("page 0 defaults, so a pre-paging feed IS page 0", () => {
    assert.equal(hex(topicUserCollection(ADDR)), hex(topicUserCollection(ADDR, 0)));
    assert.equal(hex(topicEventDirectory()), hex(topicEventDirectory(0)));
  });
});

describe("the collision #197 reported is now unrepresentable", () => {
  it("rejects a component carrying the page separator", () => {
    // Before the guard: topic("abc/p1", 0) === topic("abc", 1).
    assert.throws(() => topicUserCollection("0xabc/p1", 0), /Invalid feed topic ethAddress/);
    assert.throws(() => topicCreatorDirectory("0xabc/p1", 0), /Invalid feed topic ethAddress/);
  });

  it("no component can collide with another component's page", () => {
    // The invariant: a 2-segment path cannot equal a 3-segment one while no
    // component holds a "/". Spot-check the shape that used to break.
    assert.notEqual(
      hex(topicUserCollection("0xabc9999", 1)),
      hex(topicUserCollection("0xabc9998", 0)),
    );
  });

  it("rejects an empty component rather than building a blank segment", () => {
    assert.throws(() => topicUserCollection("", 0), /Invalid feed topic ethAddress/);
  });

  it("rejects a non-integer or negative page", () => {
    assert.throws(() => topicUserCollection(ADDR, 1.5), /Invalid feed topic page/);
    assert.throws(() => topicUserCollection(ADDR, -1), /Invalid feed topic page/);
    assert.throws(() => topicUserCollection(ADDR, NaN), /Invalid feed topic page/);
  });

  it("accepts a lowercased eth address", () => {
    assert.equal(
      hex(topicUserCollection(ADDR, 0)),
      hex(Topic.fromString(`woco/pod/collection/${ADDR}`)),
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
