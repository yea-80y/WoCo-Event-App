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
  readServed: <T>(get: () => Promise<T | null> | T | null, opts: {
    until?: number; quick?: number; quickMs?: number; slowMs?: number;
    now?: () => number; sleep: (ms: number) => Promise<void>; onWait?: () => void;
  }) => Promise<T | null>;
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

const OLD_BATCH = "d".repeat(64);
const reading = (id: string, extra: Record<string, unknown> = {}) => ({
  ok: true, batch: `${id.slice(0, 12)}…`, batchTTL: 5 * DAY, batchTTLDays: 5, checkedAt: "2026-11-20T00:00:00.000Z", ...extra,
});
const watched = (extra: Record<string, unknown> = {}, section: Record<string, unknown> = {}) => ({
  ok: true, configured: true, minTtlSeconds: 2 * DAY, batches: [reading(BATCH, extra)], ...section,
});

test("a release may go on a batch the server watches, when the chain has it for a day or more", () => {
  assert.deepEqual(checks.releaseWatchProblems(watched(), BATCH, DAY), []);
  assert.deepEqual(checks.releaseWatchProblems(watched({ batchTTL: DAY, ok: false }), BATCH, DAY), []);
});

test("a server watching no releases batch refuses the release", () => {
  for (const section of [undefined, null, {}, watched({}, { configured: false }), watched({}, { batches: undefined })]) {
    assert.match(checks.releaseWatchProblems(section, BATCH, DAY).join(), /not watching a releases batch/);
  }
});

test("a server watching only other batches refuses the release, and says which it watches", () => {
  const other = watched({}, { batches: [reading(OLD_BATCH)] });
  assert.match(checks.releaseWatchProblems(other, BATCH, DAY).join(), /watches releases batch dddddddd, and this run would upload to eeeeeeee - add it/);
  assert.match(checks.releaseWatchProblems(watched({ batch: null }), BATCH, DAY).join(), /add it to the server's RELEASE_BATCH_ID/);
  assert.match(checks.releaseWatchProblems(watched({ batch: "…" }), BATCH, DAY).join(), /add it to the server's RELEASE_BATCH_ID/);
  assert.match(checks.releaseWatchProblems(watched({}, { batches: [] }), BATCH, DAY).join(), /watches releases batch none/);
});

test("with a replaced batch still watched, the release is judged on its own batch's reading", () => {
  const both = (mine: Record<string, unknown>, old: Record<string, unknown>) => watched({}, { batches: [reading(OLD_BATCH, old), reading(BATCH, mine)] });
  // The old batch running low is the alarm's business, not a reason to refuse a release onto the new one.
  assert.deepEqual(checks.releaseWatchProblems(both({}, { ok: false, batchTTL: 3600 }), BATCH, DAY), []);
  assert.match(checks.releaseWatchProblems(both({ batchTTL: 3600 }, {}), BATCH, DAY).join(), /eeeeeeee has 0\.0 days left on chain/);
  assert.match(checks.releaseWatchProblems(both({ batchTTL: null, reason: "x" }, {}), BATCH, DAY).join(), /no chain record of releases batch eeeeeeee \(x\)/);
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
  assert.match(probes, /const label = batchLabel\(batchId\);\s*const read = \{ batch: label,/);
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
// Reading an upload back: a fresh one is waited for, an earlier one is not
// ---------------------------------------------------------------------------

/** A clock that only moves when the code under test sleeps, and a source served from `servedAt`. */
function network(servedAt: number) {
  let clock = 0;
  const sleeps: number[] = [];
  let asked = 0;
  let waits = 0;
  return {
    opts: (until: number) => ({
      until, now: () => clock, onWait: () => { waits++; },
      sleep: async (ms: number) => { sleeps.push(ms); clock += ms; },
    }),
    get: async () => { asked++; return clock >= servedAt ? { body: "bytes" } : null; },
    seen: () => ({ asked, waits, sleeps, clock }),
  };
}
const MIN = 60_000;

test("what is served at once is read once, with no wait", async () => {
  const n = network(0);
  assert.deepEqual(await checks.readServed(n.get, n.opts(0)), { body: "bytes" });
  assert.deepEqual(n.seen(), { asked: 1, waits: 0, sleeps: [], clock: 0 });
});

test("a hiccup is tried again a few seconds apart, without calling it a wait", async () => {
  const n = network(5000);
  assert.deepEqual(await checks.readServed(n.get, n.opts(0)), { body: "bytes" });
  assert.deepEqual(n.seen(), { asked: 3, waits: 0, sleeps: [3000, 3000], clock: 6000 });
});

test("a release uploaded earlier is not waited for: four reads, then it is a miss", async () => {
  const n = network(Infinity);
  assert.equal(await checks.readServed(n.get, n.opts(0)), null);
  assert.deepEqual(n.seen(), { asked: 4, waits: 0, sleeps: [3000, 3000, 3000], clock: 9000 });
});

test("an upload this run made is waited for until our bee serves it", async () => {
  // Six minutes: the longest seen on the first release made this way.
  const n = network(6 * MIN);
  assert.deepEqual(await checks.readServed(n.get, n.opts(20 * MIN)), { body: "bytes" });
  const { waits, clock, sleeps } = n.seen();
  assert.equal(waits, 1, "said once that it is waiting");
  assert.ok(clock >= 6 * MIN && clock < 6 * MIN + 15_000, "read as soon as it was served");
  assert.deepEqual(sleeps.slice(0, 4), [3000, 3000, 3000, 15_000]);
});

test("an upload that never reaches our bee is a miss once its time is up, not before", async () => {
  const n = network(Infinity);
  assert.equal(await checks.readServed(n.get, n.opts(20 * MIN)), null);
  const { waits, clock } = n.seen();
  assert.equal(waits, 1);
  assert.ok(clock >= 20 * MIN && clock < 20 * MIN + 15_000, "gave up at the deadline");
});

test("a refusal or an error is not waited for, even on a fresh upload: four reads, then a miss", async () => {
  const n = network(Infinity);
  let asked = 0;
  const refused = async () => { asked++; throw new Error("HTTP 403"); };
  assert.equal(await checks.readServed(refused, n.opts(20 * MIN)), null);
  assert.equal(asked, 4);
  assert.deepEqual(n.seen().sleeps, [3000, 3000, 3000]);
  assert.equal(n.seen().waits, 0, "never called a wait");
});

test("errors in the middle of a wait are forgiven while 'not here yet' answers keep coming", async () => {
  // Not here, then two errors, then not here, ... : the run of errors never reaches four.
  const n = network(6 * MIN);
  let asked = 0;
  const flaky = async () => {
    const i = asked++;
    if (i % 3 !== 0 && n.seen().clock < 6 * MIN) throw new Error("socket hang up");
    return n.get();
  };
  assert.deepEqual(await checks.readServed(flaky, n.opts(20 * MIN)), { body: "bytes" });
  assert.ok(n.seen().clock >= 6 * MIN);
});

test("a read that throws was not served, and is asked again", async () => {
  let rejected = 0;
  const rejects = async () => { if (rejected++ < 2) throw new Error("socket hang up"); return { body: "bytes" }; };
  let thrown = 0;
  const throws = () => { if (thrown++ < 2) throw new Error("not even a promise"); return { body: "bytes" }; };
  assert.deepEqual(await checks.readServed(rejects, { sleep: async () => {} }), { body: "bytes" });
  assert.deepEqual(await checks.readServed(throws, { sleep: async () => {} }), { body: "bytes" });
  assert.equal(rejected, 3);
  assert.equal(thrown, 3);
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
  // Only an upload this run made is waited for; a release held earlier gets no wait.
  const verify = at("await verify(L, root, up ? Date.now() + NETWORK_WAIT_MS : 0);");
  const archive = at("if (up) archive(L, up);");
  const holdStop = at("if (HOLD) {");
  const feedWrite = at(".uploadPayload(coreBatch, payload");
  assert.ok(heldCheck < batchCheck && batchCheck < watchCheck && watchCheck < dryStop && dryStop < upload, "held file, batch, watch, dry-run stop, then the upload");
  assert.ok(redescribe < verify && upload < verify, "a held root is described again, and an upload made, before the checks");
  assert.ok(verify < archive && archive < holdStop && holdStop < feedWrite, "checks, then the archive, then --hold stops, then the feed write");
  // --release-held uploads nothing, so the batch's fullness is not asked of it.
  assert.match(src, /\}, \{ uploading: !held \}\);/);
});

test("the publish script hands each check the real thing to judge", () => {
  const src = readFileSync(new URL("../../../scripts/publish-site-runtime.cjs", import.meta.url), "utf8");
  // Whether the build is the commit it names is worked out from git, recorded with a hold, and asked again at release.
  assert.match(src, /const dirty = Boolean\(git\('status', '--porcelain'\)\) \|\| commit !== git\('rev-parse', 'origin\/main'\);/);
  assert.match(src, /commit, dirty, builtAt, releaseBatch,/);
  assert.match(src, /heldReleaseProblems\(held, \{ commit, releaseBatch, allowDirty: ALLOW_DIRTY, lines: LINES\.map\(\(L\) => L\.line\) \}\)/);
  // A file is judged against the level the upload asked for, never the one it happens to have.
  assert.match(src, /storedFileProblem\(rootChunkSpan\(new Uint8Array\(await r\.arrayBuffer\(\)\)\), sizeOf\(f\), Number\(REDUNDANCY_LEVEL\)\)/);
  // A page that cannot be built stops the run.
  assert.match(src, /try \{\s*trialPage\(L, root, rootNode, template\.body\);\s*\} catch \(e\) \{\s*die\(/);
  // Every file is read through both gateways, bytes and type.
  assert.match(src, /for \(const \[where, get\] of \[\['our gateway', viaGateway\], \["Etherna's gateway", viaEtherna\]\]\) \{/);
  assert.match(src, /sha256\(back\.body\) !== want \? 'not the bytes built' : servedTypeProblem\(f, back\.type\)/);
  assert.match(src, /if \(problem\) unread\.push\(/);
  assert.match(src, /if \(unread\.length\) die\(/);
  // The published descriptor carries the root as described from storage, for a held release too.
  assert.match(src, /root = await describe\(held\.runtimes\[L\.line\]\.root\.root, index\);/);
  // A check that finds something stops the run.
  const has = (text: string) => assert.ok(src.includes(text), `the script has: ${text}`);
  has("if (heldProblems.length) die(heldProblems.join('; '));");
  has("if (!sameRootDescription(root, held.runtimes[L.line].root)) die(");
  has("releaseWatchProblems((await healthRes.json().catch(() => null))?.postage?.releases, releaseBatch, RELEASE_BATCH_MIN_TTL_SECONDS);");
  has("if (watch.length) die(watch.join('; '));");
  // The two reads go to two different places, and the trial is the shared builders, not a stand-in.
  // Our bee is given time to fetch a fresh upload; Etherna, which holds what it took, is not.
  has("const viaGateway = (p) => read(() => fetch(`${GATEWAY}${p}`), networkBy);");
  has("const viaEtherna = (p) => read(() => etherna.get(p), 0);");
  has("}, { until, sleep, onWait });");
  // A root node our bee does not serve, and one it serves wrongly, each stop the run.
  has("if (nodeBack.missed) die(");
  has("if (template.missed) die(");
  // Only "not here" (404) is waited for; every other answer is a failure, named in the refusal.
  has("if (r.status === 404) return null;");
  has("return got ?? { missed: last };");
  has("const problem = back.missed ? `not served (${back.missed})` : ");
  has("if (Buffer.compare(nodeBack.body, Buffer.from(rootNode)) !== 0) die(");
  has("return collection.buildSiteCollection({ ...on, site,");
  has("return collection.buildEventPageCollection({");
});
