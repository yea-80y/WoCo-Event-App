/**
 * The decisions `publish-site-runtime.cjs` makes about a release, as plain functions
 * so each can be tested without an upload (apps/web/test/site-runtime-checks.test.ts).
 * Each returns what is wrong, in words the script prints, or nothing when it is fine.
 */

const HEX64 = /^[0-9a-f]{64}$/;
const short = (v) => String(v ?? '?').slice(0, 8);

/**
 * Why a held release (`--hold`) must not be published by this run. A build made
 * with `--allow-dirty` is not the commit it names, so it is published only when
 * that is said again; a held file that does not say is treated as one.
 */
function heldReleaseProblems(held, { commit, releaseBatch, allowDirty, lines }) {
  if (!held || typeof held !== 'object' || Array.isArray(held)) return ['no held release (.swarm/site-runtime-held.json) - run --hold first'];
  if (held.commit !== commit) return [`the held release was built from ${short(held.commit)}, and HEAD is ${short(commit)} - run --hold again`];
  if (held.releaseBatch !== releaseBatch) return ['the held release is on another releases batch than RELEASE_BATCH_ID - run --hold again'];
  if (held.dirty !== false && !allowDirty) {
    return ['the held release was not built from a clean main (--hold --allow-dirty): it is published only with --allow-dirty again'];
  }
  if (typeof held.builtAt !== 'string' || !held.builtAt) return ['the held release does not say when it was built - run --hold again'];
  for (const line of lines) {
    if (!HEX64.test(String(held.runtimes?.[line]?.root?.root ?? ''))) return [`the held release has no ${line} root - run --hold again`];
  }
  return [];
}

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}

/** True when two descriptions of a release root (root, edges, files, index document) say the same thing. */
function sameRootDescription(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** Files built but not stored, and paths stored that were not built. */
function manifestDifference(localFiles, storedPaths) {
  const local = new Set(localFiles);
  const stored = new Set(storedPaths);
  return {
    missing: localFiles.filter((f) => !stored.has(f)),
    extra: [...stored].filter((f) => !local.has(f)),
  };
}

/**
 * What is wrong with how a file larger than one chunk was stored, from its root
 * chunk's span (`rootChunkSpan`): it must be erasure-coded, at the level asked for
 * (the level is part of the address, so a re-upload at another level lands
 * elsewhere), and as long as the file built.
 */
function storedFileProblem(span, size, level) {
  if (!span.coded) return 'stored without erasure coding';
  if (span.level !== level) return `erasure-coded at level ${span.level}, not ${level}`;
  if (span.length !== size) return `stored as ${span.length} bytes, built as ${size}`;
  return null;
}

/**
 * A browser refuses a module script that is not served as JavaScript and a
 * stylesheet that is not served as CSS, whatever the bytes are. The type comes from
 * the storing node's own table, so it is checked on what a gateway actually serves.
 */
function servedTypeProblem(file, contentType) {
  const type = String(contentType ?? '').trim().toLowerCase();
  if (/\.m?js$/i.test(file) && !/^(text|application)\/javascript(;|$)/.test(type)) return `served as "${type || 'no type'}", not JavaScript`;
  if (/\.css$/i.test(file) && !/^text\/css(;|$)/.test(type)) return `served as "${type || 'no type'}", not CSS`;
  return null;
}

/**
 * Why a release must not go onto this batch, from the live server's own
 * `/api/health` `postage.releases` section. Etherna holds the batch and has taken
 * saves onto a batch that had already expired (2026-10-16), so its word alone is
 * not enough: the server's section is read from OUR bee's record of the chain. It
 * also proves the alarm is watching the batch the release is about to go on. The
 * server may watch several (a replaced batch stays watched while pages still load
 * from it); each is reported by a label, the id's first characters.
 */
function releaseWatchProblems(section, releaseBatch, minTtlSeconds) {
  if (!section || typeof section !== 'object' || section.configured !== true || !Array.isArray(section.batches)) {
    return ['the server is not watching a releases batch: set RELEASE_BATCH_ID in the server env and deploy it before publishing a release'];
  }
  const labelOf = (b) => String(b?.batch ?? '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  const mine = section.batches.find((b) => labelOf(b).length >= 8 && releaseBatch.startsWith(labelOf(b)));
  if (!mine) {
    const watched = section.batches.map((b) => short(labelOf(b))).join(', ') || 'none';
    return [`the server watches releases batch ${watched}, and this run would upload to ${short(releaseBatch)} - add it to the server's RELEASE_BATCH_ID first`];
  }
  if (!(typeof mine.batchTTL === 'number' && Number.isFinite(mine.batchTTL))) {
    return [`our bee has no chain record of releases batch ${short(releaseBatch)} (${mine.reason || 'not read yet'}) - never upload to a batch the chain does not confirm`];
  }
  if (mine.batchTTL < minTtlSeconds) {
    return [`releases batch ${short(releaseBatch)} has ${(mine.batchTTL / 86_400).toFixed(1)} days left on chain - top it up before publishing a release onto it`];
  }
  return [];
}

module.exports = {
  heldReleaseProblems,
  sameRootDescription,
  manifestDifference,
  storedFileProblem,
  servedTypeProblem,
  releaseWatchProblems,
};
