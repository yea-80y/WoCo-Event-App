#!/usr/bin/env node
/**
 * Publish the organiser-site runtime as ONE immutable release (#1032, slice 1).
 *
 * Builds `apps/web/dist-multisite`, uploads it once to our bee (CORE batch: never
 * replaced, only topped up - a site pinned to a release must not go blank when a
 * builds batch is swapped) and to the Etherna platform batch, reads each root's
 * shared top-level directories and files, and writes a signed release descriptor
 * (`packages/shared/src/site/runtime-release.ts`) as the next update of the
 * `woco-site-runtime-v1` feed under the frontend deploy key.
 *
 * Sites do not use releases yet (slice 3); this only publishes them.
 *
 * Run in the REAL repo (`~/projects/woco_app`), on a clean main equal to
 * origin/main: the multisite build reads gitignored `apps/web/.env*`, so a
 * worktree builds a different artefact.
 *
 *   node scripts/publish-site-runtime.cjs [--dry-run] [--no-etherna] [--allow-dirty]
 *
 * Secrets: scripts/.env (UPLOAD_SECRET, POSTAGE_BATCH_ID = core, FEED_PRIVATE_KEY =
 * deploy key) and, for Etherna, apps/server/.env (ETHERNA_*). Nothing secret is
 * printed.
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const flags = new Set(process.argv.slice(2));
for (const f of flags) {
  if (!['--dry-run', '--no-etherna', '--allow-dirty'].includes(f)) {
    console.error(`Unknown flag ${f}`);
    process.exit(2);
  }
}
const DRY_RUN = flags.has('--dry-run');
const NO_ETHERNA = flags.has('--no-etherna');
const ALLOW_DIRTY = flags.has('--allow-dirty');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'apps/web/dist-multisite');
const STATE = path.join(REPO, '.swarm/site-runtime.json');
const GATEWAY = 'https://gateway.woco-net.com';
const HEX64 = /^[0-9a-f]{64}$/;

const die = (msg) => { console.error(`Not publishing: ${msg}`); process.exit(1); };
const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).trim();
const readEnv = (file, pick) => Object.fromEntries(
  fs.readFileSync(file, 'utf8').split('\n')
    .map((l) => /^([A-Z_0-9]+)=(.*)$/.exec(l.trim())).filter(Boolean)
    .filter((m) => pick(m[1]))
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]),
);
const hex = (u8) => Buffer.from(u8).toString('hex');

async function main() {
  // 1. Where and what we build from.
  if (git('rev-parse', '--git-dir') !== git('rev-parse', '--git-common-dir')) die('this is a linked worktree; run in the real repo');
  if (!ALLOW_DIRTY && git('status', '--porcelain')) die('the working tree is not clean');
  git('fetch', '--quiet', 'origin', 'main');
  const commit = git('rev-parse', 'HEAD');
  if (!ALLOW_DIRTY && commit !== git('rev-parse', 'origin/main')) die(`HEAD ${commit.slice(0, 8)} is not origin/main`);

  const { tsImport } = require('tsx/esm/api');
  const shared = await tsImport('../packages/shared/src/site/runtime-release.ts', __filename);
  const { Bee, MantarayNode, PrivateKey, Topic } = require('@ethersphere/bee-js');

  const env = readEnv(path.join(REPO, 'scripts/.env'), (k) => ['UPLOAD_SECRET', 'POSTAGE_BATCH_ID', 'FEED_PRIVATE_KEY'].includes(k));
  if (!env.UPLOAD_SECRET || !HEX64.test(String(env.POSTAGE_BATCH_ID).toLowerCase()) || !env.FEED_PRIVATE_KEY) {
    die('scripts/.env needs UPLOAD_SECRET, POSTAGE_BATCH_ID (core) and FEED_PRIVATE_KEY (deploy key)');
  }
  const signer = new PrivateKey(env.FEED_PRIVATE_KEY.replace(/^0x/, ''));
  const owner = `0x${signer.publicKey().address().toHex()}`.toLowerCase();
  if (owner !== shared.SITE_RUNTIME_RELEASE_OWNER) die(`FEED_PRIVATE_KEY is ${owner}, not the release owner ${shared.SITE_RUNTIME_RELEASE_OWNER}`);
  const coreBatch = env.POSTAGE_BATCH_ID.toLowerCase();
  const uploadHeaders = { 'x-upload-secret': env.UPLOAD_SECRET };

  // 2. Build, then measure what we built.
  console.log(`Building the site runtime at ${commit.slice(0, 8)}...`);
  const build = spawnSync('npm', ['run', 'build:multisite'], { cwd: REPO, stdio: 'inherit' });
  if (build.status !== 0) die('npm run build:multisite failed');
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      e.isDirectory() ? walk(p) : files.push(p);
    }
  })(DIST);
  const dist = { files: files.length, bytes: files.reduce((a, f) => a + fs.statSync(f).size, 0) };
  console.log(`Runtime: ${dist.files} files, ${(dist.bytes / 1e6).toFixed(1)} MB`);

  // 3. The core batch must take ~2,000 chunks without a bucket overwriting anything.
  const stamps = await (await fetch(`${GATEWAY}/stamps`)).json();
  const core = (stamps.stamps || []).find((s) => String(s.batchID).toLowerCase() === coreBatch);
  if (!core || !core.usable) die(`core batch ${coreBatch.slice(0, 8)} is not usable on our bee`);
  const cap = 2 ** (core.depth - core.bucketDepth);
  if (core.utilization >= (cap * 3) / 4) {
    die(`core batch's fullest bucket is ${core.utilization}/${cap}: a mutable batch overwrites its oldest chunk when a bucket fills - top it up (deeper) first`);
  }

  // 4. The next version and feed index.
  const topic = Topic.fromString(shared.SITE_RUNTIME_FEED_TOPIC);
  const feedUrl = `${GATEWAY}/feeds/${owner.slice(2)}/${topic.toHex()}`;
  const latest = await fetch(feedUrl);
  let version = 1;
  let nextIndex = 0n;
  if (latest.status === 200) {
    const prev = shared.parseSiteRuntimeRelease(JSON.parse(Buffer.from(await latest.arrayBuffer()).toString('utf8')));
    if (!prev) die('the latest release descriptor on the feed does not parse - fix that before publishing over it');
    version = prev.version + 1;
    const next = latest.headers.get('swarm-feed-index-next');
    if (!next || !/^[0-9a-f]+$/i.test(next)) die('the feed read gave no swarm-feed-index-next');
    nextIndex = BigInt(`0x${next}`);
  } else if (latest.status !== 404) {
    die(`could not read the release feed (HTTP ${latest.status}) - never guess the next version`);
  }
  console.log(`Next release: v${version} at feed index ${nextIndex}`);

  if (DRY_RUN) {
    console.log(`Dry run: would upload ${dist.files} files to our bee (core ${coreBatch.slice(0, 8)})${NO_ETHERNA ? '' : ' and Etherna'} and publish v${version}. Stopping.`);
    return;
  }

  // 5. Upload once per store.
  const tarPath = path.join(REPO, '.swarm/site-runtime.tar');
  fs.mkdirSync(path.dirname(tarPath), { recursive: true });
  execFileSync('tar', ['-cf', tarPath, '-C', DIST, '.']);
  const tar = fs.readFileSync(tarPath);
  fs.unlinkSync(tarPath);
  const collectionHeaders = {
    'Content-Type': 'application/x-tar',
    'Swarm-Index-Document': 'multi-site.html',
    'Swarm-Error-Document': 'multi-site.html',
    'Swarm-Collection': 'true',
    'Swarm-Deferred-Upload': 'false',
  };
  async function upload(url, headers) {
    const r = await fetch(url, { method: 'POST', body: tar, headers: { ...collectionHeaders, ...headers } });
    if (!r.ok) die(`upload to ${new URL(url).host} failed: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
    const ref = String((await r.json()).reference).toLowerCase();
    if (!HEX64.test(ref)) die(`upload to ${new URL(url).host} returned no reference`);
    return ref;
  }
  const stores = {};
  console.log('Uploading to our bee (core batch)...');
  const wocoRoot = await upload(`${GATEWAY}/bzz`, { ...uploadHeaders, 'Swarm-Postage-Batch-Id': coreBatch });
  // Our gateway serves /bytes only for whitelisted addresses, and an upload whitelists
  // just its root: list each node of the release this script reads (public anyway).
  stores.woco = {
    root: wocoRoot,
    read: async (ref) => {
      const wl = await fetch(`${GATEWAY}/admin/whitelist`, {
        method: 'POST', headers: { ...uploadHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ hash: ref }),
      });
      if (wl.status !== 200) die(`could not whitelist manifest node ${ref.slice(0, 8)}: HTTP ${wl.status}`);
      return fetch(`${GATEWAY}/bytes/${ref}`);
    },
  };
  if (!NO_ETHERNA) {
    const ethernaEnv = readEnv(path.join(REPO, 'apps/server/.env'), (k) => k.startsWith('ETHERNA_'));
    for (const [k, v] of Object.entries(ethernaEnv)) process.env[k] = v;
    if (!HEX64.test(String(process.env.ETHERNA_PLATFORM_BATCH).toLowerCase())) die('apps/server/.env has no ETHERNA_PLATFORM_BATCH');
    const auth = await tsImport('../apps/server/src/lib/etherna/auth.ts', __filename);
    const { ETHERNA_FETCH_BASE } = await tsImport('../apps/server/src/lib/etherna/gateway.ts', __filename);
    await auth.ensureEthernaToken();
    const bearer = { Authorization: `Bearer ${auth.getCachedEthernaToken()}` };
    console.log('Uploading to Etherna (platform batch)...');
    const ethernaRoot = await upload(`${ETHERNA_FETCH_BASE}/bzz`, { ...bearer, 'Swarm-Postage-Batch-Id': process.env.ETHERNA_PLATFORM_BATCH });
    stores.etherna = { root: ethernaRoot, read: (ref) => fetch(`${ETHERNA_FETCH_BASE}/bytes/${ref}`, { headers: bearer }) };
  }

  // 6. Each root's shared directories (linked whole) and loose files (added one by one).
  async function node(store, ref) {
    const r = await store.read(ref);
    if (!r.ok) die(`could not read manifest node ${ref.slice(0, 8)}: HTTP ${r.status}`);
    return MantarayNode.unmarshalFromData(new Uint8Array(await r.arrayBuffer()), Buffer.from(ref, 'hex'));
  }
  const PER_SITE = new Set(['multi-site.html', 'manifest.json']);
  const isZero = (u8) => u8.every((b) => b === 0);
  async function describe(store) {
    const root = await node(store, store.root);
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
        const child = await node(store, hex(fork.node.selfAddress));
        if (child.forks.size > 0) { await visit(name, child); continue; }
        if (isZero(child.targetAddress)) die(`manifest leaf "${name}" has no data`);
        if (PER_SITE.has(name)) continue;
        const contentType = fork.node.metadata?.['Content-Type'];
        if (!contentType) die(`shared file "${name}" has no Content-Type`);
        filesOut[name] = { ref: hex(child.targetAddress), contentType };
      }
    }
    await visit('', root);
    return { root: store.root, edges, files: filesOut, indexDocument: 'multi-site.html' };
  }
  const roots = { woco: await describe(stores.woco) };
  if (stores.etherna) roots.etherna = await describe(stores.etherna);

  // 7. The descriptor: must survive its own parser exactly, and fit one chunk.
  const descriptor = {
    format: shared.SITE_RUNTIME_FORMAT,
    version,
    commit,
    builtAt: new Date().toISOString(),
    dist,
    roots,
  };
  const parsed = shared.parseSiteRuntimeRelease(descriptor);
  if (!parsed || JSON.stringify(parsed) !== JSON.stringify(descriptor)) die('the descriptor does not round-trip through parseSiteRuntimeRelease');
  const payload = Buffer.from(JSON.stringify(descriptor), 'utf8');
  if (payload.length > 4096) die(`descriptor is ${payload.length} bytes; a feed update holds 4096`);

  // 8. Whitelist the update's address first (the app deploy's rule), then write it.
  const Binary = require(require.resolve('cafe-utility', { paths: [path.dirname(require.resolve('@ethersphere/bee-js'))] })).Binary;
  const updateId = Binary.keccak256(Binary.concatBytes(topic.toUint8Array(), Binary.numberToUint64(nextIndex, 'BE')));
  const updateAddress = Binary.uint8ArrayToHex(Binary.keccak256(Binary.concatBytes(updateId, Binary.hexToUint8Array(owner.slice(2)))));
  const wl = await fetch(`${GATEWAY}/admin/whitelist`, {
    method: 'POST', headers: { ...uploadHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ hash: updateAddress }),
  });
  if (wl.status !== 200) die(`could not whitelist the feed update: HTTP ${wl.status}`);
  const bee = new Bee(GATEWAY, { headers: uploadHeaders });
  await bee.makeFeedWriter(topic, signer).uploadPayload(coreBatch, payload, { index: Number(nextIndex) });

  // 9. Read it back: the feed's latest must be exactly what we wrote. The proxy
  // caches a non-seeded feed read for up to 60 s, so allow ~90 s.
  let readBack = false;
  for (let i = 0; i < 30 && !readBack; i++) {
    const r = await fetch(feedUrl);
    if (r.status === 200 && Buffer.compare(Buffer.from(await r.arrayBuffer()), payload) === 0) readBack = true;
    else await new Promise((res) => setTimeout(res, 3000));
  }
  if (!readBack) die(`wrote v${version} but the feed does not read it back yet - check before publishing again`);

  fs.writeFileSync(STATE, JSON.stringify({ ...descriptor, feedIndex: String(nextIndex) }, null, 2) + '\n');
  console.log(`\nPublished site runtime v${version}`);
  console.log(`  our bee root  ${roots.woco.root}  edges ${Object.keys(roots.woco.edges).join(' ')}  files ${Object.keys(roots.woco.files).join(' ')}`);
  if (roots.etherna) console.log(`  Etherna root  ${roots.etherna.root}  edges ${Object.keys(roots.etherna.edges).join(' ')}`);
  console.log(`  descriptor ${payload.length} bytes, feed index ${nextIndex}`);
}

main().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
