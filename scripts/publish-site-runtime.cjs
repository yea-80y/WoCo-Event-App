#!/usr/bin/env node
/**
 * Publish the organiser runtimes as ONE immutable release (#1032).
 *
 * Builds both runtimes from one commit - websites (`apps/web/dist-multisite`,
 * line `site`) and single-event pages (`apps/web/dist-site`, line `eventPage`) -
 * and uploads each ONCE, erasure-coded, to the releases batch on Etherna
 * (`RELEASE_BATCH_ID`, scripts/swarm-batches.cjs): a batch of its own, so old
 * releases can lapse with it without touching the core batch or user content.
 * Every file is then read back through our own gateway and through Etherna's and
 * checked, a page is built on it with the builders the app and the server use, and
 * one signed release descriptor (`woco.site-runtime.v2`,
 * `packages/shared/src/site/runtime-release.ts`) is written as the next update of
 * the `woco-site-runtime-v1` feed under the frontend deploy key. That one chunk is
 * the only thing this script puts on the core batch.
 *
 * The descriptor's two store entries name the same root: a page's own files go
 * wherever its deploy sends them, and link the one copy of the release.
 *
 * Run in the REAL repo (`~/projects/woco_app`), on a clean main equal to
 * origin/main: the builds read gitignored `apps/web/.env*`, so a worktree builds
 * a different artefact.
 *
 *   node scripts/publish-site-runtime.cjs [--hold | --release-held] [--dry-run] [--allow-dirty]
 *
 *   --hold          upload and check, write no feed update: the release exists but
 *                   the app and the server build nothing on it yet, so it can be
 *                   looked at before it is the latest.
 *   --release-held  check the held release again and make it the latest. No build,
 *                   no upload. A release held with --allow-dirty needs it again.
 *   --dry-run       stop before the first thing that would be stored: the upload,
 *                   or with --release-held the feed update.
 *
 * Each release that passed its checks is also kept under `RELEASE_ARCHIVE_DIR`
 * (outside the repo: the server deploy copies this tree to the VM) as the tar that
 * was uploaded, with a small file beside it recording the upload's settings. The
 * address of a release depends on those settings as well as on the bytes, so both
 * are what storing it again on a new releases batch would start from.
 *
 * The releases batch must be the one the live server's alarm watches
 * (`/api/health` `postage.releases`): that section is our own bee's record of the
 * chain, and Etherna's answer about a batch it holds is not taken alone.
 *
 * Secrets: scripts/.env (UPLOAD_SECRET, POSTAGE_BATCH_ID = core, RELEASE_BATCH_ID,
 * RELEASE_ARCHIVE_DIR, FEED_PRIVATE_KEY = deploy key) and apps/server/.env
 * (ETHERNA_*). Nothing secret is printed.
 */

const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { releaseBatchProblems, rootChunkSpan, RELEASE_BATCH_MIN_TTL_SECONDS } = require('./swarm-batches.cjs');
const {
  heldReleaseProblems, sameRootDescription, manifestDifference, storedFileProblem, servedTypeProblem, notHereYet, readServed, releaseWatchProblems,
} = require('./site-runtime-checks.cjs');

const flags = new Set(process.argv.slice(2));
for (const f of flags) {
  if (!['--dry-run', '--hold', '--release-held', '--allow-dirty'].includes(f)) {
    console.error(`Unknown flag ${f}`);
    process.exit(2);
  }
}
if (flags.has('--hold') && (flags.has('--release-held') || flags.has('--dry-run'))) {
  console.error('--hold goes alone: it uploads, and publishes nothing');
  process.exit(2);
}
const DRY_RUN = flags.has('--dry-run');
const HOLD = flags.has('--hold');
const RELEASE_HELD = flags.has('--release-held');
const ALLOW_DIRTY = flags.has('--allow-dirty');

const REPO = path.resolve(__dirname, '..');
const STATE = path.join(REPO, '.swarm/site-runtime.json');
const HELD = path.join(REPO, '.swarm/site-runtime-held.json');
const GATEWAY = 'https://gateway.woco-net.com';
const API = 'https://events-api.woco-net.com';
const HEX64 = /^[0-9a-f]{64}$/;
/** Bee's MEDIUM: what our own bee applies when no level is named. Etherna applies none unless asked. */
const REDUNDANCY_LEVEL = '1';
const CHUNK = 4096;
/** An undeferred upload is answered when Etherna's node has taken every chunk; past this it is not going to. */
const UPLOAD_TIMEOUT_MS = 30 * 60_000;
/**
 * How long our bee is given to fetch an upload this run just made. Etherna answers
 * before the network carries it: six minutes was the longest seen (2026-11-20).
 */
const NETWORK_WAIT_MS = 20 * 60_000;
/** Each runtime: how it is built and where. Index documents come from the shared module. */
const LINES = [
  { line: 'site', script: 'build:multisite', dist: path.join(REPO, 'apps/web/dist-multisite') },
  { line: 'eventPage', script: 'build:site', dist: path.join(REPO, 'apps/web/dist-site') },
];

const die = (msg) => { console.error(`Not publishing: ${msg}`); process.exit(1); };
const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).trim();
const readEnv = (file, pick) => Object.fromEntries(
  fs.readFileSync(file, 'utf8').split('\n')
    .map((l) => /^([A-Z_0-9]+)=(.*)$/.exec(l.trim())).filter(Boolean)
    .filter((m) => pick(m[1]))
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]),
);
const hex = (u8) => Buffer.from(u8).toString('hex');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
/** Whole or not at all: a run that dies mid-write must not leave half a state file. */
const writeFileWhole = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, data);
  fs.renameSync(`${file}.tmp`, file);
};

/** How far past bee's lookup the walk to a free feed index goes before refusing. */
const FORWARD_WALK = 8;
/** Only the one-chunk descriptor goes on the core batch: this keeps it off one about to lapse. */
const CORE_MIN_TTL_SECONDS = 1 * 86_400;
const Binary = require(require.resolve('cafe-utility', { paths: [path.dirname(require.resolve('@ethersphere/bee-js'))] })).Binary;

/** Where feed update `index` lives: keccak256(keccak256(topic || uint64be(index)) || owner), hex. */
function feedUpdateAddress(topic, index, ownerHex) {
  const id = Binary.keccak256(Binary.concatBytes(topic.toUint8Array(), Binary.numberToUint64(BigInt(index), 'BE')));
  return Binary.uint8ArrayToHex(Binary.keccak256(Binary.concatBytes(id, Binary.hexToUint8Array(ownerHex))));
}

/**
 * The version a descriptor on the feed claims, whatever its format: the floor for
 * the next release. An older format (v1) is not refused here - the server's parser
 * is what stays strict - but a payload with no readable version is.
 */
function claimedVersion(buf) {
  try {
    const v = JSON.parse(buf.toString('utf8')).version;
    return Number.isSafeInteger(v) && v >= 1 ? v : null;
  } catch {
    return null;
  }
}

/** Every file under `dir`, as paths relative to it with forward slashes. */
function listFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      e.isDirectory() ? walk(p) : out.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  })(dir);
  return out.sort();
}

/** `work` over `items`, `width` at a time, in order of arrival. */
async function pool(items, width, work) {
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

/**
 * POST a buffer and wait for the answer however long it takes: Etherna answers an
 * undeferred upload only once its node has taken every chunk, which can pass fetch's
 * own five-minute wait for response headers.
 */
function postBuffer(url, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers: { ...headers, 'Content-Length': body.length } }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(UPLOAD_TIMEOUT_MS, () => req.destroy(new Error(`no answer in ${UPLOAD_TIMEOUT_MS / 60_000} minutes`)));
    req.end(body);
  });
}

async function main() {
  // 1. Where and what we build from.
  if (git('rev-parse', '--git-dir') !== git('rev-parse', '--git-common-dir')) die('this is a linked worktree; run in the real repo');
  if (!ALLOW_DIRTY && git('status', '--porcelain')) die('the working tree is not clean');
  git('fetch', '--quiet', 'origin', 'main');
  const commit = git('rev-parse', 'HEAD');
  if (!ALLOW_DIRTY && commit !== git('rev-parse', 'origin/main')) die(`HEAD ${commit.slice(0, 8)} is not origin/main`);
  /** Only --allow-dirty gets here with this true: the build is then not the commit it names. */
  const dirty = Boolean(git('status', '--porcelain')) || commit !== git('rev-parse', 'origin/main');

  const { tsImport } = require('tsx/esm/api');
  const shared = await tsImport('../packages/shared/src/site/runtime-release.ts', __filename);
  const collection = await tsImport('../packages/shared/src/site/collection.ts', __filename);
  const templates = await tsImport('../packages/shared/src/site/templates.ts', __filename);
  const mantaray = await tsImport('../packages/shared/src/swarm/mantaray.ts', __filename);
  const { bytesTreeRoot } = await tsImport('../packages/shared/src/swarm/bytes-tree.ts', __filename);
  const { Bee, MantarayNode, PrivateKey, Topic } = require('@ethersphere/bee-js');

  const env = readEnv(path.join(REPO, 'scripts/.env'), (k) => ['UPLOAD_SECRET', 'POSTAGE_BATCH_ID', 'BUILD_BATCH_ID', 'RELEASE_BATCH_ID', 'RELEASE_ARCHIVE_DIR', 'FEED_PRIVATE_KEY'].includes(k));
  if (!env.UPLOAD_SECRET || !HEX64.test(String(env.POSTAGE_BATCH_ID).toLowerCase()) || !env.FEED_PRIVATE_KEY) {
    die('scripts/.env needs UPLOAD_SECRET, POSTAGE_BATCH_ID (core) and FEED_PRIVATE_KEY (deploy key)');
  }
  const signer = new PrivateKey(env.FEED_PRIVATE_KEY.replace(/^0x/, ''));
  const owner = `0x${signer.publicKey().address().toHex()}`.toLowerCase();
  if (owner !== shared.SITE_RUNTIME_RELEASE_OWNER) die(`FEED_PRIVATE_KEY is ${owner}, not the release owner ${shared.SITE_RUNTIME_RELEASE_OWNER}`);
  const coreBatch = env.POSTAGE_BATCH_ID.toLowerCase();
  const releaseBatch = String(env.RELEASE_BATCH_ID || '').toLowerCase();
  const uploadHeaders = { 'x-upload-secret': env.UPLOAD_SECRET };
  const archiveDir = env.RELEASE_ARCHIVE_DIR ? path.resolve(env.RELEASE_ARCHIVE_DIR) : '';
  if (!archiveDir || !path.isAbsolute(env.RELEASE_ARCHIVE_DIR)) die('scripts/.env needs RELEASE_ARCHIVE_DIR: an absolute folder outside the repo that keeps each release as uploaded');
  if (archiveDir === REPO || archiveDir.startsWith(REPO + path.sep)) die('RELEASE_ARCHIVE_DIR is inside the repo, which the server deploy copies to the VM');

  // Etherna: where the release is stored and read back from.
  const ethernaEnv = readEnv(path.join(REPO, 'apps/server/.env'), (k) => k.startsWith('ETHERNA_'));
  for (const [k, v] of Object.entries(ethernaEnv)) process.env[k] = v;
  const auth = await tsImport('../apps/server/src/lib/etherna/auth.ts', __filename);
  const { ETHERNA_FETCH_BASE } = await tsImport('../apps/server/src/lib/etherna/gateway.ts', __filename);
  const bearer = async () => {
    await auth.ensureEthernaToken();
    return { Authorization: `Bearer ${auth.getCachedEthernaToken()}` };
  };
  const etherna = {
    get: async (p) => fetch(`${ETHERNA_FETCH_BASE}${p}`, { headers: await bearer() }),
    bytes: async (ref) => {
      const r = await etherna.get(`/bytes/${ref}`);
      if (!r.ok) die(`Etherna could not serve ${ref.slice(0, 8)}: HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    },
  };
  const whitelist = async (hashes) => {
    const wl = await fetch(`${GATEWAY}/admin/whitelist`, {
      method: 'POST', headers: { ...uploadHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ hashes }),
    });
    if (wl.status !== 200) die(`could not whitelist ${hashes.length} address(es) on the gateway (HTTP ${wl.status})`);
  };

  // 2. The runtimes: built now, or the ones a --hold run built and uploaded.
  let held = null;
  if (RELEASE_HELD) {
    try {
      held = fs.existsSync(HELD) ? JSON.parse(fs.readFileSync(HELD, 'utf8')) : null;
    } catch {
      die('the held release file (.swarm/site-runtime-held.json) is not readable JSON - run --hold again');
    }
    const heldProblems = heldReleaseProblems(held, { commit, releaseBatch, allowDirty: ALLOW_DIRTY, lines: LINES.map((L) => L.line) });
    if (heldProblems.length) die(heldProblems.join('; '));
  }
  const built = {};
  for (const L of LINES) {
    if (!held) {
      console.log(`Building the ${L.line} runtime at ${commit.slice(0, 8)}...`);
      const run = spawnSync('npm', ['run', L.script], { cwd: REPO, stdio: 'inherit' });
      if (run.status !== 0) die(`npm run ${L.script} failed`);
    }
    const files = listFiles(L.dist);
    const dist = { files: files.length, bytes: files.reduce((a, f) => a + fs.statSync(path.join(L.dist, f)).size, 0) };
    console.log(`  ${L.line}: ${dist.files} files, ${(dist.bytes / 1e6).toFixed(1)} MB`);
    // Every subdirectory becomes a linked edge, served under each page's root on our
    // origin: nothing in one may open as a document (a plugin dropping an index.html
    // or an .svg into assets/ would put script on that origin).
    const documents = files.filter((f) => f.includes('/') && /\.(x?html?|svg|xml)$/i.test(f));
    if (documents.length) die(`${L.line}: linked directories would carry document types: ${documents.slice(0, 5).join(', ')}`);
    if (!files.includes(shared.SITE_RUNTIME_INDEX_DOCUMENT[L.line])) die(`${L.line}: no ${shared.SITE_RUNTIME_INDEX_DOCUMENT[L.line]} in the build`);
    built[L.line] = { dist, files };
  }

  // 3. The batches. Releases: Etherna's own answer, and our bee's record of the chain
  // as the live server reports it. Core: it takes the descriptor chunk.
  const stampRes = await etherna.get(`/stamps/${releaseBatch || 'unset'}`);
  if (!stampRes.ok && stampRes.status !== 404) die(`could not read the releases batch from Etherna (HTTP ${stampRes.status}) - re-run`);
  const problems = releaseBatchProblems(stampRes.ok ? await stampRes.json() : null, {
    release: releaseBatch, core: coreBatch, build: env.BUILD_BATCH_ID, platform: process.env.ETHERNA_PLATFORM_BATCH,
  }, { uploading: !held });
  if (problems.length) die(problems.join('; '));
  const healthRes = await fetch(`${API}/api/health`).catch(() => null);
  if (!healthRes?.ok) die(`could not read the server's health (${healthRes ? `HTTP ${healthRes.status}` : 'no answer'}) - it says whether the chain still has the releases batch`);
  const watch = releaseWatchProblems((await healthRes.json().catch(() => null))?.postage?.releases, releaseBatch, RELEASE_BATCH_MIN_TTL_SECONDS);
  if (watch.length) die(watch.join('; '));
  const stamps = await (await fetch(`${GATEWAY}/stamps`)).json();
  const core = (stamps.stamps || []).find((s) => String(s.batchID).toLowerCase() === coreBatch);
  if (!core || !core.usable) die(`core batch ${coreBatch.slice(0, 8)} is not usable on our bee`);
  if (!(core.batchTTL >= CORE_MIN_TTL_SECONDS)) die(`core batch expires in ${(Number(core.batchTTL) / 86_400).toFixed(1)} days - top it up before writing a release descriptor onto it`);
  const cap = 2 ** (core.depth - core.bucketDepth);
  if (core.utilization >= (cap * 3) / 4) {
    die(`core batch's fullest bucket is ${core.utilization}/${cap}: a mutable batch overwrites its oldest chunk when a bucket fills - deepen it first`);
  }

  // 4. The next version and feed index (not for --hold, which writes no update).
  // Bee's lookup is a LOWER bound (and a 404 is "never written" only when bee says
  // exactly that), the last publish's state is a floor, and the target slot is then
  // read by EXACT index - which checks the owner's signature - walking past taken
  // slots, all before anything is uploaded.
  const topic = Topic.fromString(shared.SITE_RUNTIME_FEED_TOPIC);
  const ownerHex = owner.slice(2);
  const bee = new Bee(GATEWAY, { headers: uploadHeaders });
  const reader = bee.makeFeedReader(topic, ownerHex);
  const readAt = async (i) => {
    try {
      return Buffer.from((await reader.downloadPayload({ index: Number(i) })).payload.toUint8Array());
    } catch (e) {
      if (e?.status === 404) return null;
      throw e;
    }
  };
  let version = null;
  let nextIndex = null;
  if (!HOLD) {
    const feedUrl = `${GATEWAY}/feeds/${ownerHex}/${topic.toHex()}`;
    const latest = await fetch(feedUrl);
    version = 1;
    let lookupIdx = 0n;
    if (latest.status === 200) {
      const prev = claimedVersion(Buffer.from(await latest.arrayBuffer()));
      if (prev === null) die('the latest release descriptor on the feed has no readable version - fix that before publishing over it');
      version = prev + 1;
      const next = latest.headers.get('swarm-feed-index-next');
      if (!next || !/^[0-9a-f]+$/i.test(next)) die('the feed read gave no swarm-feed-index-next');
      lookupIdx = BigInt(`0x${next}`);
    } else if (latest.status === 404) {
      const message = String((await latest.json().catch(() => ({}))).message ?? '');
      if (message !== 'no update found') die(`bee's feed lookup answered 404 "${message}", which does not prove the feed is empty`);
    } else {
      die(`could not read the release feed (HTTP ${latest.status}) - never guess the next version`);
    }
    const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : null;
    if (state) {
      version = Math.max(version, Number(state.version) + 1);
      if (BigInt(state.feedIndex) + 1n > lookupIdx) lookupIdx = BigInt(state.feedIndex) + 1n;
    }

    const reachable = Array.from({ length: FORWARD_WALK + 1 }, (_, k) => lookupIdx + BigInt(k));
    await whitelist(reachable.map((i) => feedUpdateAddress(topic, i, ownerHex)));
    for (const i of reachable.slice(0, FORWARD_WALK)) {
      let taken;
      try {
        taken = await readAt(i);
      } catch (e) {
        die(`cannot tell whether feed index ${i} is taken (${e?.message ?? e}) - nothing was uploaded, re-run`);
      }
      if (taken === null) { nextIndex = i; break; }
      // A taken slot is a release bee's lookup did not report: publish above it.
      const seen = claimedVersion(taken);
      if (seen !== null) version = Math.max(version, seen + 1);
    }
    if (nextIndex === null) die(`more than ${FORWARD_WALK} feed updates past ${lookupIdx}: refusing to guess where to write`);
    console.log(`Next release: v${version} at feed index ${nextIndex}`);
  }

  if (DRY_RUN && !held) {
    const files = LINES.map((L) => `${built[L.line].dist.files} ${L.line}`).join(' + ');
    console.log(`Dry run: would upload ${files} files to Etherna (releases batch ${releaseBatch.slice(0, 8)}) and publish v${version}. Stopping.`);
    return;
  }

  // 5. One upload per runtime, erasure-coded. The tar is kept once it has passed its checks.
  async function upload(L) {
    const tarPath = path.join(REPO, '.swarm/site-runtime.tar');
    fs.mkdirSync(path.dirname(tarPath), { recursive: true });
    execFileSync('tar', ['-cf', tarPath, '-C', L.dist, '.']);
    const tar = fs.readFileSync(tarPath);
    fs.unlinkSync(tarPath);
    const index = shared.SITE_RUNTIME_INDEX_DOCUMENT[L.line];
    const r = await postBuffer(`${ETHERNA_FETCH_BASE}/bzz`, {
      'Content-Type': 'application/x-tar',
      'Swarm-Index-Document': index,
      'Swarm-Error-Document': index,
      'Swarm-Collection': 'true',
      'Swarm-Deferred-Upload': 'false',
      'Swarm-Redundancy-Level': REDUNDANCY_LEVEL,
      'Swarm-Postage-Batch-Id': releaseBatch,
      ...(await bearer()),
    }, tar);
    if (r.status < 200 || r.status >= 300) die(`upload to Etherna failed: HTTP ${r.status} ${r.text.slice(0, 160)}`);
    let ref = '';
    try { ref = String(JSON.parse(r.text).reference).toLowerCase(); } catch { /* refused below */ }
    if (!HEX64.test(ref)) die('upload to Etherna returned no reference');
    return { ref, tar, index };
  }
  function archive(L, up) {
    writeFileWhole(path.join(archiveDir, `${L.line}-${up.ref}.tar`), up.tar);
    writeFileWhole(path.join(archiveDir, `${L.line}-${up.ref}.json`), JSON.stringify({
      line: L.line, root: up.ref, commit, dirty, uploadedAt: new Date().toISOString(), releaseBatch,
      redundancyLevel: Number(REDUNDANCY_LEVEL), indexDocument: up.index, errorDocument: up.index,
      tarBytes: up.tar.length, tarSha256: sha256(up.tar),
    }, null, 2) + '\n');
  }

  // 6. A root's shared directories (linked whole) and loose files (added one by one).
  async function node(ref) {
    return MantarayNode.unmarshalFromData(await etherna.bytes(ref), Buffer.from(ref, 'hex'));
  }
  const isZero = (u8) => u8.every((b) => b === 0);
  async function describe(rootRef, indexDocument) {
    // A page writes its own index document and manifest.json; neither is offered.
    const perPage = new Set([indexDocument, 'manifest.json']);
    const root = await node(rootRef);
    const edges = {};
    const filesOut = {};
    async function visit(parentPath, n) {
      for (const fork of n.forks.values()) {
        const name = parentPath + Buffer.from(fork.prefix).toString('utf8');
        if (name === '/') continue; // the root's own metadata (index document)
        const slash = name.indexOf('/');
        if (slash !== -1) {
          if (slash !== name.length - 1) die(`unexpected manifest shape at "${name}"`);
          edges[name] = hex(fork.node.selfAddress);
          continue;
        }
        const child = await node(hex(fork.node.selfAddress));
        if (child.forks.size > 0) { await visit(name, child); continue; }
        if (isZero(child.targetAddress)) die(`manifest leaf "${name}" has no data`);
        if (perPage.has(name)) continue;
        const contentType = fork.node.metadata?.['Content-Type'];
        if (!contentType) die(`shared file "${name}" has no Content-Type`);
        if (!shared.isSiteRuntimeFileType(contentType)) {
          console.log(`  not offering ${name} (${contentType})`);
          continue;
        }
        filesOut[name] = { ref: hex(child.targetAddress), contentType };
      }
    }
    await visit('', root);
    return { root: rootRef, edges, files: filesOut, indexDocument };
  }

  /** A page built on this root with the builders the app and the server use; throws when none can be. */
  function trialPage(L, root, rootNode, template) {
    const on = { template: template.toString('utf8'), release: root, releaseRootNode: rootNode };
    const nobody = `0x${'0'.repeat(40)}`;
    if (L.line === 'site') {
      let n = 0;
      const site = templates.newSiteFromTemplate({ siteId: 'release-check', ownerAddress: nobody, templateId: 'clean-modern-v1', idGen: () => `id${n++}`, now: 0 });
      return collection.buildSiteCollection({ ...on, site, urls: collection.siteRenderUrls({ apiUrl: API, gatewayUrl: GATEWAY, wocoAppUrl: 'https://woco.eth.limo' }) });
    }
    return collection.buildEventPageCollection({
      ...on, head: null, config: { apiUrl: API, gatewayUrl: GATEWAY, contentGatewayUrl: GATEWAY, eventId: 'release-check', eventSigner: nobody },
    });
  }

  /**
   * What a page and the server will ask of this root, checked before anything
   * builds on it: the manifest holds exactly the files built; each file larger than
   * one chunk is erasure-coded, at the level asked for and at its full length; the
   * root node and the template match the addresses the server's kit checks
   * (lib/site/collection-publish.ts); a page builds on it; and every file reads
   * back, byte for byte and as a type a browser will run, through our own gateway
   * (from the network, the way a visitor's browser gets it) and through Etherna's
   * (where pages stored on Etherna are served).
   *
   * Not proved: that every data chunk reached the network. A read rebuilds a missing
   * chunk from the parity, so it cannot tell. The upload is undeferred, but Etherna
   * answers it minutes before our bee can fetch it (2026-11-20), so its answer is not
   * that proof either. What the reads through our gateway do show is that the network
   * serves every file.
   *
   * `networkBy` is how long our bee has to fetch an upload this run just made (0 for
   * a release held earlier). Reads from Etherna never wait: it holds what it took.
   */
  async function verify(L, root, networkBy) {
    const index = shared.SITE_RUNTIME_INDEX_DOCUMENT[L.line];
    const local = built[L.line].files;
    const sizeOf = (f) => fs.statSync(path.join(L.dist, f)).size;

    const tree = await MantarayNode.unmarshal(new Bee(ETHERNA_FETCH_BASE, { headers: await bearer() }), root.root);
    await tree.loadRecursively(new Bee(ETHERNA_FETCH_BASE, { headers: await bearer() }));
    const stored = new Map(tree.collect().map((n) => [n.fullPathString, hex(n.targetAddress)]));
    const { missing, extra } = manifestDifference(local, [...stored.keys()]);
    if (missing.length || extra.length) die(`${L.line}: the stored manifest is not the build (missing ${missing.slice(0, 3).join(', ') || 'none'}; extra ${extra.slice(0, 3).join(', ') || 'none'})`);

    const large = local.filter((f) => sizeOf(f) > CHUNK);
    if (large.length === 0) die(`${L.line}: no file larger than one chunk to check erasure coding on`);
    const badlyStored = [];
    await pool(large, 8, async (f) => {
      const r = await etherna.get(`/chunks/${stored.get(f)}`);
      if (!r.ok) die(`${L.line}: Etherna could not serve the root chunk of ${f}: HTTP ${r.status}`);
      const problem = storedFileProblem(rootChunkSpan(new Uint8Array(await r.arrayBuffer())), sizeOf(f), Number(REDUNDANCY_LEVEL));
      if (problem) badlyStored.push(`${f}: ${problem}`);
    });
    if (badlyStored.length) die(`${L.line}: ${badlyStored.length} file(s) were not stored as asked (${badlyStored.slice(0, 3).join('; ')})`);

    const rootNode = await etherna.bytes(root.root);
    if (mantaray.mantarayNodeAddress(rootNode) !== root.root) die(`${L.line}: the root node does not match its address`);
    const entry = await mantaray.resolveMantarayPath(rootNode, index, (a) => etherna.bytes(a));
    await whitelist([root.root]);
    let saidWaiting = false;
    const onWait = (answer) => {
      if (saidWaiting) return;
      saidWaiting = true;
      console.log(`  ${L.line}: our bee does not serve this upload yet (${answer}) - asking again for up to ${Math.ceil((networkBy - Date.now()) / 60_000)} more minutes...`);
    };
    // What was read, or `{ missed }` naming the last answer. A file whose first chunk has
    // arrived and whose later ones have not is served as a body that stops: not here yet.
    const read = async (get, until) => {
      let last = 'no answer';
      const got = await readServed(async () => {
        let r;
        try {
          r = await get();
        } catch (e) {
          last = e?.message || 'no answer';
          throw new Error(last);
        }
        last = `HTTP ${r.status}`;
        if (!r.ok) {
          if (notHereYet(r.status)) return null;
          throw new Error(last);
        }
        try {
          return { body: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') };
        } catch (e) {
          last = `HTTP ${r.status}, then the body stopped (${e?.message || 'no reason given'})`;
          return null;
        }
      }, { until, sleep, onWait: () => onWait(last) });
      return got ?? { missed: last };
    };
    const viaGateway = (p) => read(() => fetch(`${GATEWAY}${p}`), networkBy);
    const viaEtherna = (p) => read(() => etherna.get(p), 0);
    const nodeBack = await viaGateway(`/bytes/${root.root}`);
    if (nodeBack.missed) die(`${L.line}: our bee does not serve the root node Etherna holds (${nodeBack.missed})`);
    if (Buffer.compare(nodeBack.body, Buffer.from(rootNode)) !== 0) die(`${L.line}: our bee serves a root node that is not the one Etherna holds`);
    const template = await viaGateway(`/bzz/${root.root}/${index}`);
    if (template.missed) die(`${L.line}: our bee does not serve the template (${template.missed})`);
    if (bytesTreeRoot(new Uint8Array(template.body)) !== entry) die(`${L.line}: the template our bee serves does not match its entry in the manifest`);

    try {
      trialPage(L, root, rootNode, template.body);
    } catch (e) {
      die(`${L.line}: no page can be built on this release (${e?.message ?? e})`);
    }

    const unread = [];
    await pool(local, 6, async (f) => {
      const want = sha256(fs.readFileSync(path.join(L.dist, f)));
      const p = `/bzz/${root.root}/${f.split('/').map(encodeURIComponent).join('/')}`;
      for (const [where, get] of [['our gateway', viaGateway], ["Etherna's gateway", viaEtherna]]) {
        const back = await get(p);
        const problem = back.missed ? `not served (${back.missed})` : sha256(back.body) !== want ? 'not the bytes built' : servedTypeProblem(f, back.type);
        if (problem) unread.push(`${f} through ${where}: ${problem}`);
      }
    });
    if (unread.length) die(`${L.line}: ${unread.length} read(s) of ${local.length} files did not come back as built (${unread.slice(0, 3).join('; ')})`);
    console.log(`  ${L.line}: ${local.length} files read back as built through both gateways, ${large.length} checked erasure-coded, a page builds on it`);
  }

  const runtimes = {};
  for (const L of LINES) {
    const index = shared.SITE_RUNTIME_INDEX_DOCUMENT[L.line];
    let up = null;
    let root;
    if (held) {
      // The held file names the root; what the root holds is read again, never taken from the file.
      root = await describe(held.runtimes[L.line].root.root, index);
      if (!sameRootDescription(root, held.runtimes[L.line].root)) die(`${L.line}: the held release file does not describe what is stored at its root - run --hold again`);
    } else {
      console.log(`Uploading the ${L.line} runtime to Etherna (releases batch ${releaseBatch.slice(0, 8)})...`);
      up = await upload(L);
      root = await describe(up.ref, index);
    }
    console.log(`Checking the ${L.line} runtime at ${root.root}...`);
    await verify(L, root, up ? Date.now() + NETWORK_WAIT_MS : 0);
    if (up) archive(L, up);
    runtimes[L.line] = { dist: built[L.line].dist, roots: { woco: root, etherna: root } };
  }

  if (HOLD) {
    const builtAt = new Date().toISOString();
    writeFileWhole(HELD, JSON.stringify({
      commit, dirty, builtAt, releaseBatch,
      runtimes: Object.fromEntries(LINES.map((L) => [L.line, { dist: built[L.line].dist, root: runtimes[L.line].roots.woco }])),
    }, null, 2) + '\n');
    console.log('\nHeld: uploaded and checked, not published. Nothing builds on it yet.');
    for (const L of LINES) console.log(`  ${L.line.padEnd(9)} root ${runtimes[L.line].roots.woco.root}`);
    console.log('  Make it the latest release with --release-held.');
    return;
  }

  // 7. The descriptor: must survive its own parser exactly, and fit one chunk.
  const descriptor = {
    format: shared.SITE_RUNTIME_FORMAT,
    version,
    commit,
    builtAt: held ? held.builtAt : new Date().toISOString(),
    runtimes,
  };
  const parsed = shared.parseSiteRuntimeRelease(descriptor);
  if (!parsed || JSON.stringify(parsed) !== JSON.stringify(descriptor)) die('the descriptor does not round-trip through parseSiteRuntimeRelease');
  const payload = Buffer.from(JSON.stringify(descriptor), 'utf8');
  if (payload.length > 4096) die(`descriptor is ${payload.length} bytes; a feed update holds 4096`);
  if (DRY_RUN) {
    console.log(`Dry run: the held release checks out; would publish it as v${version} at feed index ${nextIndex}. Stopping.`);
    return;
  }

  // 8. Write it at the free index found (already whitelisted with its window).
  await bee.makeFeedWriter(topic, signer).uploadPayload(coreBatch, payload, { index: Number(nextIndex) });

  // 9. Read it back by EXACT index (full retrieval, signature checked): a SOC at a
  // taken index keeps its first bytes, so only a byte-equal read proves ours landed.
  let back = null;
  for (let i = 0; i < 5 && !(back && Buffer.compare(back, payload) === 0); i++) {
    back = await readAt(nextIndex).catch(() => null);
    if (!(back && Buffer.compare(back, payload) === 0)) await sleep(2000);
  }
  if (!back || Buffer.compare(back, payload) !== 0) die(`wrote v${version} at index ${nextIndex} but it does not read back as written - check before publishing again`);

  writeFileWhole(STATE, JSON.stringify({ ...descriptor, releaseBatch, feedIndex: String(nextIndex) }, null, 2) + '\n');
  // A held release this publish did not use is now behind the latest: it is not kept to be released later.
  fs.rmSync(HELD, { force: true });
  console.log(`\nPublished site runtime v${version}`);
  for (const L of LINES) {
    const r = runtimes[L.line].roots.woco;
    console.log(`  ${L.line.padEnd(9)} root ${r.root}  edges ${Object.keys(r.edges).join(' ')}  files ${Object.keys(r.files).join(' ')}`);
  }
  console.log(`  descriptor ${payload.length} bytes, feed index ${nextIndex}`);
}

main().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
