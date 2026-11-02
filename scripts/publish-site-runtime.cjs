#!/usr/bin/env node
/**
 * Publish the organiser runtimes as ONE immutable release (#1032).
 *
 * Builds both runtimes from one commit - websites (`apps/web/dist-multisite`,
 * line `site`) and single-event pages (`apps/web/dist-site`, line `eventPage`) -
 * uploads each once to our bee (CORE batch: never replaced, only topped up - a
 * page pinned to a release must not go blank when a builds batch is swapped) and
 * to the Etherna platform batch, reads each root's shared top-level directories
 * and files, and writes one signed release descriptor (`woco.site-runtime.v2`,
 * `packages/shared/src/site/runtime-release.ts`) as the next update of the
 * `woco-site-runtime-v1` feed under the frontend deploy key.
 *
 * Run in the REAL repo (`~/projects/woco_app`), on a clean main equal to
 * origin/main: the builds read gitignored `apps/web/.env*`, so a worktree builds
 * a different artefact.
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
const STATE = path.join(REPO, '.swarm/site-runtime.json');
const GATEWAY = 'https://gateway.woco-net.com';
const HEX64 = /^[0-9a-f]{64}$/;
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

/** How far past bee's lookup the walk to a free feed index goes before refusing. */
const FORWARD_WALK = 8;
const CORE_MIN_TTL_SECONDS = 3 * 86_400;
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

  // 2. Build both runtimes, then measure what we built.
  const built = {};
  for (const L of LINES) {
    console.log(`Building the ${L.line} runtime at ${commit.slice(0, 8)}...`);
    const run = spawnSync('npm', ['run', L.script], { cwd: REPO, stdio: 'inherit' });
    if (run.status !== 0) die(`npm run ${L.script} failed`);
    const files = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        e.isDirectory() ? walk(p) : files.push(p);
      }
    })(L.dist);
    const dist = { files: files.length, bytes: files.reduce((a, f) => a + fs.statSync(f).size, 0) };
    console.log(`  ${L.line}: ${dist.files} files, ${(dist.bytes / 1e6).toFixed(1)} MB`);
    // Every subdirectory becomes a linked edge, served under each page's root on our
    // origin: nothing in one may open as a document (a plugin dropping an index.html
    // or an .svg into assets/ would put script on that origin).
    const documents = files.map((f) => path.relative(L.dist, f)).filter((f) => f.includes(path.sep) && /\.(x?html?|svg|xml)$/i.test(f));
    if (documents.length) die(`${L.line}: linked directories would carry document types: ${documents.slice(0, 5).join(', ')}`);
    if (!fs.existsSync(path.join(L.dist, shared.SITE_RUNTIME_INDEX_DOCUMENT[L.line]))) die(`${L.line}: no ${shared.SITE_RUNTIME_INDEX_DOCUMENT[L.line]} in the build`);
    built[L.line] = dist;
  }

  // 3. The core batch must take both runtimes (~2,000 chunks each) without a bucket overwriting anything.
  const stamps = await (await fetch(`${GATEWAY}/stamps`)).json();
  const core = (stamps.stamps || []).find((s) => String(s.batchID).toLowerCase() === coreBatch);
  if (!core || !core.usable) die(`core batch ${coreBatch.slice(0, 8)} is not usable on our bee`);
  if (!(core.batchTTL >= CORE_MIN_TTL_SECONDS)) die(`core batch expires in ${(Number(core.batchTTL) / 86_400).toFixed(1)} days - top it up before publishing a release onto it`);
  const cap = 2 ** (core.depth - core.bucketDepth);
  if (core.utilization >= (cap * 3) / 4) {
    die(`core batch's fullest bucket is ${core.utilization}/${cap}: a mutable batch overwrites its oldest chunk when a bucket fills - top it up (deeper) first`);
  }

  // 4. The next version and feed index. Bee's lookup is a LOWER bound (and a 404 is
  // "never written" only when bee says exactly that), the last publish's state is a
  // floor, and the target slot is then read by EXACT index - which checks the
  // owner's signature - walking past taken slots, all before anything is uploaded.
  const topic = Topic.fromString(shared.SITE_RUNTIME_FEED_TOPIC);
  const ownerHex = owner.slice(2);
  const feedUrl = `${GATEWAY}/feeds/${ownerHex}/${topic.toHex()}`;
  const latest = await fetch(feedUrl);
  let version = 1;
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
  const wlWindow = await fetch(`${GATEWAY}/admin/whitelist`, {
    method: 'POST', headers: { ...uploadHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes: reachable.map((i) => feedUpdateAddress(topic, i, ownerHex)) }),
  });
  if (wlWindow.status !== 200) die(`could not whitelist feed updates ${lookupIdx}-${lookupIdx + BigInt(FORWARD_WALK)} on the gateway (HTTP ${wlWindow.status})`);
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
  let nextIndex = null;
  for (const i of reachable.slice(0, FORWARD_WALK)) {
    let held;
    try {
      held = await readAt(i);
    } catch (e) {
      die(`cannot tell whether feed index ${i} is taken (${e?.message ?? e}) - nothing was uploaded, re-run`);
    }
    if (held === null) { nextIndex = i; break; }
    // A taken slot is a release bee's lookup did not report: publish above it.
    const seen = claimedVersion(held);
    if (seen !== null) version = Math.max(version, seen + 1);
  }
  if (nextIndex === null) die(`more than ${FORWARD_WALK} feed updates past ${lookupIdx}: refusing to guess where to write`);
  console.log(`Next release: v${version} at feed index ${nextIndex}`);

  if (DRY_RUN) {
    const files = LINES.map((L) => `${built[L.line].files} ${L.line}`).join(' + ');
    console.log(`Dry run: would upload ${files} files to our bee (core ${coreBatch.slice(0, 8)})${NO_ETHERNA ? '' : ' and Etherna'} and publish v${version}. Stopping.`);
    return;
  }

  // 5. The stores: our bee always, Etherna unless told not to.
  const stores = {
    woco: {
      bzz: `${GATEWAY}/bzz`,
      headers: { ...uploadHeaders, 'Swarm-Postage-Batch-Id': coreBatch },
      // Our gateway serves /bytes only for whitelisted addresses, and an upload whitelists
      // just its root: list each node of the release this script reads (public anyway).
      read: async (ref) => {
        const wl = await fetch(`${GATEWAY}/admin/whitelist`, {
          method: 'POST', headers: { ...uploadHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ hash: ref }),
        });
        if (wl.status !== 200) die(`could not whitelist manifest node ${ref.slice(0, 8)}: HTTP ${wl.status}`);
        return fetch(`${GATEWAY}/bytes/${ref}`);
      },
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
    stores.etherna = {
      bzz: `${ETHERNA_FETCH_BASE}/bzz`,
      headers: { ...bearer, 'Swarm-Postage-Batch-Id': process.env.ETHERNA_PLATFORM_BATCH },
      read: (ref) => fetch(`${ETHERNA_FETCH_BASE}/bytes/${ref}`, { headers: bearer }),
    };
  }

  async function upload(store, dist, indexDocument) {
    const tarPath = path.join(REPO, '.swarm/site-runtime.tar');
    fs.mkdirSync(path.dirname(tarPath), { recursive: true });
    execFileSync('tar', ['-cf', tarPath, '-C', dist, '.']);
    const tar = fs.readFileSync(tarPath);
    fs.unlinkSync(tarPath);
    const r = await fetch(store.bzz, {
      method: 'POST',
      body: tar,
      headers: {
        'Content-Type': 'application/x-tar',
        'Swarm-Index-Document': indexDocument,
        'Swarm-Error-Document': indexDocument,
        'Swarm-Collection': 'true',
        'Swarm-Deferred-Upload': 'false',
        ...store.headers,
      },
    });
    if (!r.ok) die(`upload to ${new URL(store.bzz).host} failed: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
    const ref = String((await r.json()).reference).toLowerCase();
    if (!HEX64.test(ref)) die(`upload to ${new URL(store.bzz).host} returned no reference`);
    return ref;
  }

  // 6. Each root's shared directories (linked whole) and loose files (added one by one).
  async function node(store, ref) {
    const r = await store.read(ref);
    if (!r.ok) die(`could not read manifest node ${ref.slice(0, 8)}: HTTP ${r.status}`);
    return MantarayNode.unmarshalFromData(new Uint8Array(await r.arrayBuffer()), Buffer.from(ref, 'hex'));
  }
  const isZero = (u8) => u8.every((b) => b === 0);
  async function describe(store, rootRef, indexDocument) {
    // A page writes its own index document and manifest.json; neither is offered.
    const perPage = new Set([indexDocument, 'manifest.json']);
    const root = await node(store, rootRef);
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

  const runtimes = {};
  for (const L of LINES) {
    const index = shared.SITE_RUNTIME_INDEX_DOCUMENT[L.line];
    const roots = {};
    for (const [name, store] of Object.entries(stores)) {
      console.log(`Uploading the ${L.line} runtime to ${name === 'woco' ? 'our bee (core batch)' : 'Etherna (platform batch)'}...`);
      roots[name] = await describe(store, await upload(store, L.dist, index), index);
    }
    runtimes[L.line] = { dist: built[L.line], roots };
  }

  // 7. The descriptor: must survive its own parser exactly, and fit one chunk.
  const descriptor = {
    format: shared.SITE_RUNTIME_FORMAT,
    version,
    commit,
    builtAt: new Date().toISOString(),
    runtimes,
  };
  const parsed = shared.parseSiteRuntimeRelease(descriptor);
  if (!parsed || JSON.stringify(parsed) !== JSON.stringify(descriptor)) die('the descriptor does not round-trip through parseSiteRuntimeRelease');
  const payload = Buffer.from(JSON.stringify(descriptor), 'utf8');
  if (payload.length > 4096) die(`descriptor is ${payload.length} bytes; a feed update holds 4096`);

  // 8. Write it at the free index found (already whitelisted with its window).
  await bee.makeFeedWriter(topic, signer).uploadPayload(coreBatch, payload, { index: Number(nextIndex) });

  // 9. Read it back by EXACT index (full retrieval, signature checked): a SOC at a
  // taken index keeps its first bytes, so only a byte-equal read proves ours landed.
  let back = null;
  for (let i = 0; i < 5 && !(back && Buffer.compare(back, payload) === 0); i++) {
    back = await readAt(nextIndex).catch(() => null);
    if (!(back && Buffer.compare(back, payload) === 0)) await new Promise((res) => setTimeout(res, 2000));
  }
  if (!back || Buffer.compare(back, payload) !== 0) die(`wrote v${version} at index ${nextIndex} but it does not read back as written - check before publishing again`);

  fs.writeFileSync(STATE, JSON.stringify({ ...descriptor, feedIndex: String(nextIndex) }, null, 2) + '\n');
  console.log(`\nPublished site runtime v${version}`);
  for (const L of LINES) {
    for (const [name, r] of Object.entries(runtimes[L.line].roots)) {
      console.log(`  ${L.line.padEnd(9)} ${name.padEnd(7)} root ${r.root}  edges ${Object.keys(r.edges).join(' ')}  files ${Object.keys(r.files).join(' ')}`);
    }
  }
  console.log(`  descriptor ${payload.length} bytes, feed index ${nextIndex}`);
}

main().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
