/**
 * The two deploy-time refusals in front of every app and scanner upload
 * (scripts/swarm-batches.cjs), and that both upload scripts put them first.
 *
 * Bundles go on the BUILDS batch, feed updates and manifests on the CORE batch.
 * The builds batch is invisible to /api/health, so the deploy is the only check
 * on it. And a recorded feed state from another feed must never be reused: its
 * gateway mark would set the new feed's first index (the old app feed's mark
 * would have started `woco-app-v1` at 276), and its manifest would be reused.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { keccak256, toUtf8Bytes } from "ethers";

const batches = createRequire(import.meta.url)("../../../scripts/swarm-batches.cjs") as {
  batchProblems: (stamps: unknown, ids: { build: string; core: string }) => string[];
  manifestStateProblem: (state: unknown, ownerHex: string, topicHex: string) => string | null;
  BUILD_BATCH_MIN_TTL_SECONDS: number;
};

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const CORE = "c".repeat(64);
const BUILD = "b".repeat(64);
const DAY = 86_400;

function stamp(batchID: string, extra: Record<string, unknown> = {}) {
  return { batchID, usable: true, batchTTL: 14 * DAY, depth: 19, bucketDepth: 16, utilization: 1, ...extra };
}
const healthy = () => [stamp(CORE), stamp(BUILD)];

// ---------------------------------------------------------------------------
// batchProblems
// ---------------------------------------------------------------------------

test("two healthy, different batches may deploy", () => {
  assert.deepEqual(batches.batchProblems(healthy(), { build: BUILD, core: CORE }), []);
});

test("ids match whatever their case", () => {
  assert.deepEqual(batches.batchProblems(healthy(), { build: BUILD.toUpperCase(), core: CORE.toUpperCase() }), []);
});

test("no builds batch configured is a refusal, never a fall back to core", () => {
  const [p] = batches.batchProblems(healthy(), { build: "", core: CORE });
  assert.match(p, /BUILD_BATCH_ID is not a batch id/);
});

test("the builds batch may not be the core batch", () => {
  const [p] = batches.batchProblems([stamp(CORE)], { build: CORE, core: CORE });
  assert.match(p, /is the core batch/);
});

test("a core batch the bee does not hold, or cannot use yet, refuses", () => {
  assert.match(batches.batchProblems([stamp(BUILD)], { build: BUILD, core: CORE }).join(), /core batch cccccccc is not one of this bee's batches/);
  assert.match(
    batches.batchProblems([stamp(CORE, { usable: false }), stamp(BUILD)], { build: BUILD, core: CORE }).join(),
    /core batch cccccccc is not usable yet/,
  );
});

test("a builds batch the bee does not hold, or cannot use yet, refuses", () => {
  assert.match(batches.batchProblems([stamp(CORE)], { build: BUILD, core: CORE }).join(), /builds batch bbbbbbbb is not one of this bee's batches/);
  assert.match(
    batches.batchProblems([stamp(CORE), stamp(BUILD, { usable: false })], { build: BUILD, core: CORE }).join(),
    /builds batch bbbbbbbb is not usable yet/,
  );
});

test("a builds batch under three days refuses; exactly three days does not", () => {
  const min = batches.BUILD_BATCH_MIN_TTL_SECONDS;
  assert.equal(min, 3 * DAY);
  const short = batches.batchProblems([stamp(CORE), stamp(BUILD, { batchTTL: min - 1 })], { build: BUILD, core: CORE });
  assert.match(short.join(), /expires in 3\.0 days/);
  assert.deepEqual(batches.batchProblems([stamp(CORE), stamp(BUILD, { batchTTL: min })], { build: BUILD, core: CORE }), []);
});

test("a builds batch whose fullest bucket is at three quarters refuses (depth 19: 6 of 8)", () => {
  const at = (u: number, depth = 19) =>
    batches.batchProblems([stamp(CORE), stamp(BUILD, { utilization: u, depth })], { build: BUILD, core: CORE });
  assert.deepEqual(at(5), []);
  assert.match(at(6).join(), /fullest bucket is 6\/8/);
  // Deeper batch, bigger buckets: depth 20 holds 16 per bucket.
  assert.deepEqual(at(11, 20), []);
  assert.match(at(12, 20).join(), /fullest bucket is 12\/16/);
});

test("a missing /stamps answer refuses rather than passing", () => {
  assert.equal(batches.batchProblems(undefined, { build: BUILD, core: CORE }).length, 2);
});

// ---------------------------------------------------------------------------
// manifestStateProblem
// ---------------------------------------------------------------------------

const OWNER = "f8af4904c6e4f08ce5f7deab7f01221280b23a80";
const APP_TOPIC = keccak256(toUtf8Bytes("woco-app-v1")).slice(2);
const OLD_TOPIC = keccak256(toUtf8Bytes("woco-events-v1")).slice(2);

test("no recorded state is a new feed - nothing to refuse", () => {
  assert.equal(batches.manifestStateProblem(null, OWNER, APP_TOPIC), null);
});

test("the old app feed's real state is refused for the new topic, naming the fix", () => {
  assert.equal(OLD_TOPIC, "aef7b3bb8b50eff1516536370de7ab15de8e24592a35d2abd9977d00ebb650b2");
  const old = { manifestRef: "d66c6ff7650a468c2fd98439c8f04547b5b8a4b933d349ff16db1d0b00c23adc", owner: OWNER, topic: OLD_TOPIC };
  assert.match(batches.manifestStateProblem(old, OWNER, APP_TOPIC) ?? "", /move \.swarm\/feed-manifest\.json aside/);
});

test("the same feed's own state passes, however its hex is written", () => {
  const state = { manifestRef: "a".repeat(64), owner: `0x${OWNER.toUpperCase()}`, topic: `0x${APP_TOPIC}` };
  assert.equal(batches.manifestStateProblem(state, `0x${OWNER}`, APP_TOPIC), null);
});

test("another owner's state is refused", () => {
  const state = { manifestRef: "a".repeat(64), owner: "1".repeat(40), topic: APP_TOPIC };
  assert.notEqual(batches.manifestStateProblem(state, OWNER, APP_TOPIC), null);
});

test("a state with no owner or topic is refused, not trusted", () => {
  assert.notEqual(batches.manifestStateProblem({ manifestRef: "a".repeat(64) }, OWNER, APP_TOPIC), null);
});

test("a state with no usable manifestRef is refused", () => {
  assert.match(batches.manifestStateProblem({ owner: OWNER, topic: APP_TOPIC }, OWNER, APP_TOPIC) ?? "", /no valid manifestRef/);
});

// ---------------------------------------------------------------------------
// Both upload scripts: refuse first, bundle on builds, feed on core
// ---------------------------------------------------------------------------

for (const [name, rel, firstUpload] of [
  ["app", "../../../scripts/upload-to-swarm-feed.cjs", "await uploadDist('pass1')"],
  ["scanner", "../../../scripts/upload-scanner-to-swarm.cjs", "await axios.post(`${BEE_URL}/bzz`, tarData"],
] as const) {
  test(`the ${name} upload refuses before it reads the feed or uploads, and splits its batches`, () => {
    const src = source(rel);
    const stateCheck = src.indexOf("manifestStateProblem(manifestState, ownerHex, topic.toString())");
    const batchCheck = src.indexOf("batchProblems(stamps, { build: BUILD_BATCH_ID, core: POSTAGE_BATCH_ID })");
    const firstFeedRead = src.indexOf("/feeds/${ownerHex}/${topic.toString()}");
    const upload = src.indexOf(firstUpload);
    assert.ok(stateCheck > 0 && batchCheck > stateCheck, "both checks present, state first");
    assert.match(src, /if \(stateProblem\) throw new Error\(`Not deploying: \$\{stateProblem\}`\);/);
    assert.match(src, /if \(problems\.length\) throw new Error\(/);
    assert.ok(upload > batchCheck, "nothing is uploaded before the checks");
    assert.ok(firstFeedRead > batchCheck, "the feed is not read before the checks");
    // The one read of the recorded state is the checked one.
    assert.equal(src.split("readJsonIfExists(MANIFEST_STATE)").length - 1, 1);
    // Bundle on builds; manifest and feed update on core.
    assert.match(src, /'Swarm-Postage-Batch-Id': BUILD_BATCH_ID,/);
    assert.doesNotMatch(src, /'Swarm-Postage-Batch-Id': POSTAGE_BATCH_ID,/);
    assert.match(src, /createFeedManifest\(\s*POSTAGE_BATCH_ID, topic, ownerObj/);
    assert.match(src, /uploadReference\(\s*POSTAGE_BATCH_ID,/);
  });
}

test("the app feed is woco-app-v1", () => {
  assert.match(source("../../../scripts/upload-to-swarm-feed.cjs"), /const FEED_TOPIC = 'woco-app-v1';/);
});
