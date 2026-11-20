#!/usr/bin/env node
/**
 * Publish the organiser runtimes as ONE immutable release (#1032).
 *
 * Builds both runtimes from one commit - websites (`apps/web/dist-multisite`,
 * line `site`) and single-event pages (`apps/web/dist-site`, line `eventPage`) -
 * and uploads each ONCE, erasure-coded, to the releases batch on Etherna
 * (`RELEASE_BATCH_ID`, scripts/swarm-batches.cjs): a batch of its own, so old
 * releases can lapse with it without touching the core batch or user content.
 * Every file is then read back through our own gateway and checked, and one
 * signed release descriptor (`woco.site-runtime.v2`,
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
 *                   nothing builds on it yet. For trying a page on it first.
 *   --release-held  check the held release again and make it the latest. No build,
 *                   no upload.
 *   --dry-run       stop before the first thing that would be stored: the upload,
 *                   or with --release-held the feed update.
 *
 * Each upload is also kept as a tar under `RELEASE_ARCHIVE_DIR` (outside the repo:
 * the server deploy copies this tree to the VM). The same tar uploaded to a new
 * releases batch lands at the same addresses, which is how a release live pages
 * still link is carried when the batch is replaced.
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
const { releaseBatchProblems, rootChunkSpan } = require('./swarm-batches.cjs');

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
const HEX64 = /^[0-9a-f]{64}$/;
/** Bee's MEDIUM: what our own bee applies when no level is named. Etherna applies none unless asked. */
const REDUNDANCY_LEVEL = '1';
const CHUNK = 4096;
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
 * undeferred upload only once every chunk is pushed, which can pass fetch's own
 * five-minute wait for response headers.
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

  const { tsImport } = require('tsx/esm/api');
  const shared = await tsImport('../packages/shared/src/site/runtime-release.ts', __filename);
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
  const held = RELEASE_HELD ? (fs.existsSync(HELD) ? JSON.parse(fs.readFileSync(HELD, 'utf8')) : die('no held release (.swarm/site-runtime-held.json) - run --hold first')) : null;
  if (held && held.commit !== commit) die(`the held release was built from ${String(held.commit).slice(0, 8)}, and HEAD is ${commit.slice(0, 8)} - run --hold again`);
  if (held && held.releaseBatch !== releaseBatch) die('the held release is on another releases batch than RELEASE_BATCH_ID - run --hold again');
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

  // 3. The batches. Releases: Etherna's own answer. Core: it takes the descriptor chunk.
  const stampRes = await etherna.get(`/stamps/${releaseBatch || 'unset'}`);
  const problems = releaseBatchProblems(stampRes.ok ? await stampRes.json() : null, {
    release: releaseBatch, core: coreBatch, build: env.BUILD_BATCH_ID, platform: process.env.ETHERNA_PLATFORM_BATCH,
  });
  if (problems.length) die(problems.join('; '));
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

  // 5. One upload per runtime, erasure-coded, and the tar kept as uploaded.
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
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, `${L.line}-${ref}.tar`), tar);
    return ref;
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

  /**
   * Everything a page and the server will ask of this root, proved before anything
   * builds on it: the manifest holds exactly the files built; each file larger than
   * one chunk is erasure-coded at its full length; the root node and the template
   * match the addresses the server's kit checks (lib/site/collection-publish.ts);
   * and every file reads back, byte for byte, through our own gateway - that is,
   * from the network, the way a visitor's browser gets it.
   */
  async function verify(L, root) {
    const index = shared.SITE_RUNTIME_INDEX_DOCUMENT[L.line];
    const local = built[L.line].files;

    const tree = await MantarayNode.unmarshal(new Bee(ETHERNA_FETCH_BASE, { headers: await bearer() }), root.root);
    await tree.loadRecursively(new Bee(ETHERNA_FETCH_BASE, { headers: await bearer() }));
    const stored = new Map(tree.collect().map((n) => [n.fullPathString, hex(n.targetAddress)]));
    const missing = local.filter((f) => !stored.has(f));
    const extra = [...stored.keys()].filter((f) => !local.includes(f));
    if (missing.length || extra.length) die(`${L.line}: the stored manifest is not the build (missing ${missing.slice(0, 3).join(', ') || 'none'}; extra ${extra.slice(0, 3).join(', ') || 'none'})`);

    const large = local.filter((f) => fs.statSync(path.join(L.dist, f)).size > CHUNK);
    if (large.length === 0) die(`${L.line}: no file larger than one chunk to check erasure coding on`);
    const uncoded = [];
    await pool(large, 8, async (f) => {
      const r = await etherna.get(`/chunks/${stored.get(f)}`);
      if (!r.ok) die(`${L.line}: Etherna could not serve the root chunk of ${f}: HTTP ${r.status}`);
      const span = rootChunkSpan(new Uint8Array(await r.arrayBuffer()));
      if (!span.coded || span.length !== fs.statSync(path.join(L.dist, f)).size) uncoded.push(f);
    });
    if (uncoded.length) die(`${L.line}: ${uncoded.length} file(s) were not stored erasure-coded at their full length (${uncoded.slice(0, 3).join(', ')})`);

    const rootNode = await etherna.bytes(root.root);
    if (mantaray.mantarayNodeAddress(rootNode) !== root.root) die(`${L.line}: the root node does not match its address`);
    const entry = await mantaray.resolveMantarayPath(rootNode, index, (a) => etherna.bytes(a));
    await whitelist([root.root]);
    const viaGateway = async (p) => {
      for (let attempt = 0; ; attempt++) {
        const r = await fetch(`${GATEWAY}${p}`).catch(() => null);
        if (r?.ok) return Buffer.from(await r.arrayBuffer());
        if (attempt === 3) return null;
        await sleep(3000);
      }
    };
    const nodeBack = await viaGateway(`/bytes/${root.root}`);
    if (!nodeBack || Buffer.compare(nodeBack, Buffer.from(rootNode)) !== 0) die(`${L.line}: our bee does not serve the root node Etherna holds`);
    const template = await viaGateway(`/bzz/${root.root}/${index}`);
    if (!template || bytesTreeRoot(new Uint8Array(template)) !== entry) die(`${L.line}: the template our bee serves does not match its entry in the manifest`);

    const unread = [];
    await pool(local, 6, async (f) => {
      const back = await viaGateway(`/bzz/${root.root}/${f.split('/').map(encodeURIComponent).join('/')}`);
      if (!back || sha256(back) !== sha256(fs.readFileSync(path.join(L.dist, f)))) unread.push(f);
    });
    if (unread.length) die(`${L.line}: ${unread.length} of ${local.length} files do not read back through our gateway as built (${unread.slice(0, 3).join(', ')})`);
    console.log(`  ${L.line}: ${local.length} files read back as built, ${large.length} checked erasure-coded`);
  }

  const runtimes = {};
  for (const L of LINES) {
    let root;
    if (held) {
      root = held.runtimes[L.line].root;
    } else {
      console.log(`Uploading the ${L.line} runtime to Etherna (releases batch ${releaseBatch.slice(0, 8)})...`);
      root = await describe(await upload(L), shared.SITE_RUNTIME_INDEX_DOCUMENT[L.line]);
    }
    console.log(`Checking the ${L.line} runtime at ${root.root}...`);
    await verify(L, root);
    runtimes[L.line] = { dist: built[L.line].dist, roots: { woco: root, etherna: root } };
  }

  if (HOLD) {
    const builtAt = new Date().toISOString();
    fs.writeFileSync(HELD, JSON.stringify({
      commit, builtAt, releaseBatch,
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

  fs.writeFileSync(STATE, JSON.stringify({ ...descriptor, releaseBatch, feedIndex: String(nextIndex) }, null, 2) + '\n');
  if (held) fs.unlinkSync(HELD);
  console.log(`\nPublished site runtime v${version}`);
  for (const L of LINES) {
    const r = runtimes[L.line].roots.woco;
    console.log(`  ${L.line.padEnd(9)} root ${r.root}  edges ${Object.keys(r.edges).join(' ')}  files ${Object.keys(r.files).join(' ')}`);
  }
  console.log(`  descriptor ${payload.length} bytes, feed index ${nextIndex}`);
}

main().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
