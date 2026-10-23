/**
 * The two postage batches a frontend deploy writes to (split at launch, 2026-10-23).
 *
 *   POSTAGE_BATCH_ID - CORE: feed updates, feed manifests and the sign-in window
 *     (and, on the server, every platform write). Never replaced, only topped up:
 *     a feed whose first update is on a dead batch stops resolving (#601).
 *   BUILD_BATCH_ID - BUILDS: the app and scanner bundles, nothing else. When it
 *     fills with old builds, buy a new one, set it here and deploy: only old
 *     builds go with the old batch.
 *
 * The server's /api/health watches the core batch only, so a deploy checks both
 * against the bee's own /stamps before it uploads anything.
 */

const BUILD_BATCH_MIN_TTL_SECONDS = 3 * 86_400;
const HEX64 = /^[0-9a-f]{64}$/;

const short = (id) => id.slice(0, 8);

/**
 * Why a deploy must not upload with these batches, from the bee's `/stamps` list.
 * Empty when it may.
 */
function batchProblems(stamps, { build, core }) {
  const buildId = String(build || '').toLowerCase();
  const coreId = String(core || '').toLowerCase();
  if (!HEX64.test(buildId)) {
    return ['BUILD_BATCH_ID is not a batch id in scripts/.env - bundles never fall back to the core batch'];
  }
  if (buildId === coreId) {
    return ['BUILD_BATCH_ID is the core batch (POSTAGE_BATCH_ID) - bundles go on a batch of their own'];
  }
  const find = (id) => (Array.isArray(stamps) ? stamps : []).find((s) => String(s?.batchID || '').toLowerCase() === id);
  const problems = [];

  const coreStamp = find(coreId);
  if (!coreStamp) problems.push(`core batch ${short(coreId)} is not one of this bee's batches - it may have expired`);
  else if (!coreStamp.usable) problems.push(`core batch ${short(coreId)} is not usable yet`);

  const buildStamp = find(buildId);
  if (!buildStamp) {
    problems.push(`builds batch ${short(buildId)} is not one of this bee's batches - buy a new builds batch and set BUILD_BATCH_ID`);
  } else if (!buildStamp.usable) {
    problems.push(`builds batch ${short(buildId)} is not usable yet`);
  } else {
    if (!(buildStamp.batchTTL >= BUILD_BATCH_MIN_TTL_SECONDS)) {
      const days = (Number(buildStamp.batchTTL) / 86_400).toFixed(1);
      problems.push(`builds batch ${short(buildId)} expires in ${days} days - top it up, or buy a new one and set BUILD_BATCH_ID`);
    }
    // A mutable batch overwrites the oldest chunk in a full bucket without an
    // error, and one deploy writes ~5,000 chunks: stop at three quarters.
    const cap = 2 ** (buildStamp.depth - buildStamp.bucketDepth);
    if (buildStamp.utilization >= (cap * 3) / 4) {
      problems.push(
        `builds batch ${short(buildId)}'s fullest bucket is ${buildStamp.utilization}/${cap} - buy a new builds batch, set BUILD_BATCH_ID and deploy`,
      );
    }
  }
  return problems;
}

/**
 * Why the recorded feed state (`.swarm/feed-manifest.json`) does not belong to this
 * run's feed, or null when it does or there is none. Reusing another feed's state
 * would publish under its manifest, and its gateway mark would set this feed's
 * next index.
 */
function manifestStateProblem(state, ownerHex, topicHex) {
  if (state == null) return null;
  const norm = (v) => String(v || '').toLowerCase().replace(/^0x/, '');
  const owner = norm(ownerHex);
  const topic = norm(topicHex);
  if (norm(state.owner) !== owner || norm(state.topic) !== topic) {
    return (
      `the recorded feed state is for owner ${norm(state.owner) || '?'} topic ${norm(state.topic) || '?'}, ` +
      `but this run publishes owner ${owner} topic ${topic}. To start a new feed, move .swarm/feed-manifest.json aside.`
    );
  }
  if (!HEX64.test(norm(state.manifestRef))) return 'the recorded feed state has no valid manifestRef';
  return null;
}

module.exports = { batchProblems, manifestStateProblem, BUILD_BATCH_MIN_TTL_SECONDS };
