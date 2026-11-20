/**
 * The decisions the site runtime publish script makes about a release
 * (scripts/site-runtime-checks.cjs), each on its own inputs: what a held release
 * must say before it is published, what "stored as asked" means, and that the
 * batch a release goes on is the one the live server's alarm watches.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

interface Root { root: string; edges: Record<string, string>; files: Record<string, { ref: string; contentType: string }>; indexDocument: string }
const req = createRequire(import.meta.url);
const checks = req("../../../scripts/site-runtime-checks.cjs") as {
  heldReleaseProblems: (held: unknown, now: { commit: string; releaseBatch: string; allowDirty: boolean; lines: string[] }) => string[];
  sameRootDescription: (a: unknown, b: unknown) => boolean;
  manifestDifference: (local: string[], stored: string[]) => { missing: string[]; extra: string[] };
  storedFileProblem: (span: { length: number; coded: boolean; level: number }, size: number, level: number) => string | null;
  servedTypeProblem: (file: string, contentType: string | null) => string | null;
  releaseWatchProblems: (section: unknown, releaseBatch: string, minTtlSeconds: number) => string[];
};
const batches = req("../../../scripts/swarm-batches.cjs") as {
  releaseBatchProblems: (stamp: unknown, ids: Record<string, string>, opts?: { uploading?: boolean }) => string[];
};

const DAY = 86_400;
const COMMIT = "1".repeat(40);
const BATCH = "e".repeat(64);
const LINES = ["site", "eventPage"];
const root = (seed: string): Root => ({
  root: seed.repeat(64),
  edges: { "assets/": "2".repeat(64), "icons/": "3".repeat(64) },
  files: { "favicon.ico": { ref: "4".repeat(64), contentType: "image/x-icon" } },
  indexDocument: "multi-site.html",
});
const heldFile = (extra: Record<string, unknown> = {}) => ({
  commit: COMMIT, dirty: false, builtAt: "2026-11-20T00:00:00.000Z", releaseBatch: BATCH,
  runtimes: { site: { dist: { files: 3, bytes: 9 }, root: root("a") }, eventPage: { dist: { files: 3, bytes: 9 }, root: root("b") } },
  ...extra,
});
const now = { commit: COMMIT, releaseBatch: BATCH, allowDirty: false, lines: LINES };

// ---------------------------------------------------------------------------
// A held release
// ---------------------------------------------------------------------------

test("a held release from this commit, on this batch, built clean, may be published", () => {
  assert.deepEqual(checks.heldReleaseProblems(heldFile(), now), []);
});

test("no held release, or one that is not an object, refuses", () => {
  for (const v of [null, undefined, "x", 3, []]) assert.match(checks.heldReleaseProblems(v, now).join(), /no held release/);
});

test("a held release from another commit or on another batch refuses", () => {
  assert.match(checks.heldReleaseProblems(heldFile({ commit: "2".repeat(40) }), now).join(), /built from 22222222, and HEAD is 11111111/);
  assert.match(checks.heldReleaseProblems(heldFile({ releaseBatch: "f".repeat(64) }), now).join(), /another releases batch/);
});

test("a release held from a tree that was not a clean main is published only when that is said again", () => {
  assert.match(checks.heldReleaseProblems(heldFile({ dirty: true }), now).join(), /only with --allow-dirty again/);
  assert.deepEqual(checks.heldReleaseProblems(heldFile({ dirty: true }), { ...now, allowDirty: true }), []);
  // A held file that does not say how it was built is not taken as clean.
  const silent: Record<string, unknown> = heldFile();
  delete silent.dirty;
  assert.match(checks.heldReleaseProblems(silent, now).join(), /only with --allow-dirty again/);
  assert.match(checks.heldReleaseProblems(heldFile({ dirty: "false" }), now).join(), /only with --allow-dirty again/);
});

test("a held release missing a line's root, or its build time, refuses", () => {
  const noEventPage = heldFile();
  delete (noEventPage.runtimes as Record<string, unknown>).eventPage;
  assert.match(checks.heldReleaseProblems(noEventPage, now).join(), /no eventPage root/);
  const badRoot = heldFile();
  badRoot.runtimes.site.root.root = "zz";
  assert.match(checks.heldReleaseProblems(badRoot, now).join(), /no site root/);
  assert.match(checks.heldReleaseProblems(heldFile({ builtAt: "" }), now).join(), /when it was built/);
});

test("a root's description matches only when every edge and file does", () => {
  const a = root("a");
  // Key order is not a difference.
  const reordered = { indexDocument: a.indexDocument, files: a.files, edges: { "icons/": a.edges["icons/"], "assets/": a.edges["assets/"] }, root: a.root };
  assert.equal(checks.sameRootDescription(a, reordered), true);

  const edgeGone = root("a");
  delete edgeGone.edges["assets/"];
  assert.equal(checks.sameRootDescription(a, edgeGone), false);
  const edgeMoved = root("a");
  edgeMoved.edges["assets/"] = "9".repeat(64);
  assert.equal(checks.sameRootDescription(a, edgeMoved), false);
  const fileGone = root("a");
  fileGone.files = {};
  assert.equal(checks.sameRootDescription(a, fileGone), false);
  const typeChanged = root("a");
  typeChanged.files["favicon.ico"]!.contentType = "image/png";
  assert.equal(checks.sameRootDescription(a, typeChanged), false);
  assert.equal(checks.sameRootDescription(a, { ...a, indexDocument: "site.html" }), false);
  assert.equal(checks.sameRootDescription(a, root("b")), false);
});

// ---------------------------------------------------------------------------
// What was stored
// ---------------------------------------------------------------------------

test("the stored manifest must hold exactly the files built", () => {
  assert.deepEqual(checks.manifestDifference(["a.js", "b/c.css"], ["b/c.css", "a.js"]), { missing: [], extra: [] });
  assert.deepEqual(checks.manifestDifference(["a.js", "b/c.css"], ["a.js"]), { missing: ["b/c.css"], extra: [] });
  assert.deepEqual(checks.manifestDifference(["a.js"], ["a.js", "x.html"]), { missing: [], extra: ["x.html"] });
  assert.deepEqual(checks.manifestDifference([], []), { missing: [], extra: [] });
});

test("a large file must be erasure-coded, at the level asked for, at its full length", () => {
  assert.equal(checks.storedFileProblem({ length: 40002, coded: true, level: 1 }, 40002, 1), null);
  assert.match(checks.storedFileProblem({ length: 40002, coded: false, level: 0 }, 40002, 1)!, /without erasure coding/);
  assert.match(checks.storedFileProblem({ length: 40002, coded: true, level: 2 }, 40002, 1)!, /level 2, not 1/);
  assert.match(checks.storedFileProblem({ length: 40001, coded: true, level: 1 }, 40002, 1)!, /40001 bytes, built as 40002/);
});

test("scripts and stylesheets must be served as types a browser will run", () => {
  assert.equal(checks.servedTypeProblem("assets/index-abc.js", "text/javascript; charset=utf-8"), null);
  assert.equal(checks.servedTypeProblem("assets/worker.mjs", "application/javascript"), null);
  assert.equal(checks.servedTypeProblem("assets/index-abc.css", "text/css; charset=utf-8"), null);
  assert.match(checks.servedTypeProblem("assets/index-abc.js", "application/octet-stream")!, /not JavaScript/);
  assert.match(checks.servedTypeProblem("assets/index-abc.js", null)!, /no type/);
  assert.match(checks.servedTypeProblem("assets/index-abc.js", "text/javascriptx")!, /not JavaScript/);
  assert.match(checks.servedTypeProblem("assets/index-abc.css", "text/plain")!, /not CSS/);
  // Other files are judged on their bytes alone.
  assert.equal(checks.servedTypeProblem("icons/icon-192.png", "application/octet-stream"), null);
  assert.equal(checks.servedTypeProblem("assets/font.woff2", null), null);
});

// ---------------------------------------------------------------------------
// The batch is the one the server watches, and the chain has it
// ---------------------------------------------------------------------------

const watched = (extra: Record<string, unknown> = {}) => ({
  ok: true, configured: true, batch: `${BATCH.slice(0, 12)}…`, batchTTL: 5 * DAY, batchTTLDays: 5, minTtlSeconds: 2 * DAY, checkedAt: "2026-11-20T00:00:00.000Z", ...extra,
});

test("a release may go on the batch the server watches, when the chain has it for a day or more", () => {
  assert.deepEqual(checks.releaseWatchProblems(watched(), BATCH, DAY), []);
  assert.deepEqual(checks.releaseWatchProblems(watched({ batchTTL: DAY, ok: false }), BATCH, DAY), []);
});

test("a server watching no releases batch refuses the release", () => {
  for (const section of [undefined, null, {}, watched({ configured: false })]) {
    assert.match(checks.releaseWatchProblems(section, BATCH, DAY).join(), /not watching a releases batch/);
  }
});

test("a server watching another batch refuses the release", () => {
  assert.match(checks.releaseWatchProblems(watched({ batch: `${"f".repeat(12)}…` }), BATCH, DAY).join(), /must be the same batch/);
  assert.match(checks.releaseWatchProblems(watched({ batch: null }), BATCH, DAY).join(), /must be the same batch/);
  assert.match(checks.releaseWatchProblems(watched({ batch: "…" }), BATCH, DAY).join(), /must be the same batch/);
});

test("no chain record of the batch, or under a day on chain, refuses the release", () => {
  const gone = watched({ ok: false, batchTTL: null, reason: "not on chain: the releases batch has expired" });
  assert.match(checks.releaseWatchProblems(gone, BATCH, DAY).join(), /no chain record .*not on chain/);
  assert.match(checks.releaseWatchProblems(watched({ batchTTL: null }), BATCH, DAY).join(), /no chain record .*not read yet/);
  assert.match(checks.releaseWatchProblems(watched({ batchTTL: DAY - 1 }), BATCH, DAY).join(), /1\.0 days left on chain/);
  assert.match(checks.releaseWatchProblems(watched({ batchTTL: "432000" }), BATCH, DAY).join(), /no chain record/);
});

test("the label the server reports for a batch is one this check can match", () => {
  // The server's own label (apps/server/src/lib/health/probes.ts): the id's first 12 characters and an ellipsis.
  const probes = readFileSync(new URL("../../server/src/lib/health/probes.ts", import.meta.url), "utf8");
  assert.match(probes, /function batchLabel\(batchId: string\): string \{\s*return `\$\{batchId\.slice\(0, 12\)\}…`;/);
  assert.match(probes, /batch: batchLabel\(configured\)/);
});

// ---------------------------------------------------------------------------
// A run that uploads nothing is not refused for how full the batch is
// ---------------------------------------------------------------------------

test("--release-held is not refused for a batch its own held upload filled; an upload still is", () => {
  const ids = { release: BATCH, core: "c".repeat(64), build: "b".repeat(64), platform: "a".repeat(64) };
  const full = { batchID: BATCH, usable: true, batchTTL: 5 * DAY, depth: 19, bucketDepth: 16, utilization: 6 };
  assert.match(batches.releaseBatchProblems(full, ids).join(), /fullest bucket is 6\/8/);
  assert.match(batches.releaseBatchProblems(full, ids, { uploading: true }).join(), /fullest bucket is 6\/8/);
  assert.deepEqual(batches.releaseBatchProblems(full, ids, { uploading: false }), []);
  // Everything else still refuses a run that uploads nothing.
  assert.match(batches.releaseBatchProblems({ ...full, batchTTL: DAY - 1 }, ids, { uploading: false }).join(), /expires in/);
  assert.match(batches.releaseBatchProblems({ ...full, usable: false }, ids, { uploading: false }).join(), /not usable/);
  assert.match(batches.releaseBatchProblems(null, ids, { uploading: false }).join(), /not a batch Etherna holds/);
});

// ---------------------------------------------------------------------------
// The script uses them, in the order that keeps a bad release from going live
// ---------------------------------------------------------------------------

test("the publish script runs every check before the first thing it stores, and the feed write last", () => {
  const src = readFileSync(new URL("../../../scripts/publish-site-runtime.cjs", import.meta.url), "utf8");
  const at = (needle: string) => {
    const i = src.indexOf(needle);
    assert.ok(i > 0, `the script has: ${needle}`);
    assert.equal(src.indexOf(needle, i + 1), -1, `only once: ${needle}`);
    return i;
  };
  const heldCheck = at("heldReleaseProblems(held, {");
  const batchCheck = at("releaseBatchProblems(stampRes.ok");
  const watchCheck = at("releaseWatchProblems(");
  const dryStop = at("if (DRY_RUN && !held) {");
  const upload = at("up = await upload(L);");
  const redescribe = at("sameRootDescription(root, held.runtimes[L.line].root)");
  const verify = at("await verify(L, root);");
  const archive = at("if (up) archive(L, up);");
  const holdStop = at("if (HOLD) {");
  const feedWrite = at(".uploadPayload(coreBatch, payload");
  assert.ok(heldCheck < batchCheck && batchCheck < watchCheck && watchCheck < dryStop && dryStop < upload, "held file, batch, watch, dry-run stop, then the upload");
  assert.ok(redescribe < verify && upload < verify, "a held root is described again, and an upload made, before the checks");
  assert.ok(verify < archive && archive < holdStop && holdStop < feedWrite, "checks, then the archive, then --hold stops, then the feed write");
  // --release-held uploads nothing, so the batch's fullness is not asked of it.
  assert.match(src, /\}, \{ uploading: !held \}\);/);
  // A held release records whether it was built clean.
  assert.match(src, /commit, dirty, builtAt, releaseBatch,/);
});
