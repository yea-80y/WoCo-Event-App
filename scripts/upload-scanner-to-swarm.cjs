#!/usr/bin/env node

/**
 * Swarm Feed Uploader for the WoCo door-scanner PWA (dist-scanner/).
 *
 * Same rail as upload-to-swarm-feed.cjs but for the scanner bundle, with one
 * deliberate difference: NO <base href> two-pass. The scanner is a PWA — its
 * service worker must be same-origin with the page, so the whole bundle is
 * served from gateway.woco-net.com. The stable URL is the feed manifest:
 *
 *   https://gateway.woco-net.com/bzz/{manifestRef}/
 *
 * That URL never changes across deploys. scan.woco.eth needs no record of its
 * own: the CCIP gateway answers it with this feed's latest collection
 * (apps/server/src/lib/scanner/latest-build.ts), so FEED_TOPIC is read there too.
 * `npm run deploy` runs this after every frontend upload, so the scanner is
 * re-stamped under the current batch each time.
 *
 * USAGE:
 *   npm run build:scanner
 *   node scripts/upload-scanner-to-swarm.cjs
 *   -- or --
 *   npm run deploy:scanner
 */

const { Bee, PrivateKey, Topic, Reference } = require('@ethersphere/bee-js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const tar = require('tar');
const axios = require('axios');
const { batchProblems, manifestStateProblem } = require('./swarm-batches.cjs');

// Only when run: the test suite requires this file for its pure helpers.
if (require.main === module) require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const BEE_URL = process.env.BEE_URL || 'https://gateway.woco-net.com';
// The feed update and manifest go on the core batch, the bundle on the builds batch
// (swarm-batches.cjs).
const POSTAGE_BATCH_ID = process.env.POSTAGE_BATCH_ID || '';
const BUILD_BATCH_ID = process.env.BUILD_BATCH_ID || '';
const FEED_PRIVATE_KEY = process.env.FEED_PRIVATE_KEY || '';
const UPLOAD_SECRET = process.env.UPLOAD_SECRET || '';
const SSH_HOST = process.env.SSH_HOST || 'root@46.225.174.72';
const FEED_TOPIC = 'woco-scanner-v1';
const UPLOAD_DIR = path.resolve(__dirname, '../apps/web/dist-scanner');

const STATE_DIR = path.resolve(__dirname, '../.swarm');
const MANIFEST_STATE = path.join(STATE_DIR, 'scanner-feed-manifest.json');
const INFO_STATE = path.join(STATE_DIR, 'scanner-feed-info.json');

async function ensureDir(p) { await fs.promises.mkdir(p, { recursive: true }); }
async function readJsonIfExists(p) { try { return JSON.parse(await fs.promises.readFile(p, 'utf-8')); } catch { return null; } }

const { Binary } = require(require.resolve('cafe-utility', {
  paths: [path.dirname(require.resolve('@ethersphere/bee-js'))],
}));

/** Where feed update `index` is stored: keccak256(keccak256(topic || uint64be(index)) || owner), hex. */
function feedUpdateAddress(topicHex, index, ownerHex) {
  const id = Binary.keccak256(
    Binary.concatBytes(Binary.hexToUint8Array(topicHex.replace(/^0x/, '')), Binary.numberToUint64(BigInt(index), 'BE')),
  );
  return Binary.uint8ArrayToHex(Binary.keccak256(Binary.concatBytes(id, Binary.hexToUint8Array(ownerHex.replace(/^0x/, '').toLowerCase()))));
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const why = (e) => e?.message ?? String(e);

/**
 * Proves the feed now resolves to `expectedRef`: update `index` holds it and
 * update `index + 1` does not exist. Both are read directly, because bee's lookup
 * lands short, and a write to an index that is already taken answers 201 and
 * keeps the old bytes - so without this a lost update reads as a deploy. The
 * walk below avoids a taken index; this still catches a write that raced one.
 *
 * `readAt(i)` resolves to the reference update `i` names, to null when bee says
 * there is none (404), and throws when it cannot say. Only "cannot say yet" is
 * retried: another reference at `index` cannot change, so it fails at once.
 */
async function confirmFeedHead(index, expectedRef, readAt, { attempts = 10, delayMs = 1500, sleep = sleepMs } = {}) {
  let held;
  let lastErr;
  for (let a = 0; a < attempts; a++) {
    if (a) await sleep(delayMs);
    try {
      held = await readAt(index);
      lastErr = undefined;
      if (held !== null) break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (held === undefined || held === null) {
    throw new Error(
      `Scanner feed update ${index} could not be read back after ${attempts} tries ` +
      `(${lastErr ? why(lastErr) : 'bee says it does not exist'}): this build is NOT confirmed live.`,
    );
  }
  if (held !== expectedRef) {
    throw new Error(
      `Scanner feed index ${index} holds ${held}, not this build ${expectedRef}: the index was already taken ` +
      `(bee's lookup landed short, or another upload). Nothing new is live - re-run.`,
    );
  }
  let next;
  lastErr = undefined;
  for (let a = 0; a < attempts && next === undefined; a++) {
    if (a) await sleep(delayMs);
    try {
      next = await readAt(index + 1);
    } catch (e) {
      lastErr = e;
    }
  }
  if (next === undefined) {
    throw new Error(`Scanner feed update ${index} holds this build, but update ${index + 1} could not be checked (${why(lastErr)}): NOT confirmed as the latest.`);
  }
  if (next !== null) {
    throw new Error(`Scanner feed update ${index} holds this build, but update ${index + 1} (${next}) is newer: the feed does not resolve to this build - re-run.`);
  }
}

/** How far past bee's lookup the walk to a free index goes before refusing. */
const FORWARD_WALK = 8;

/**
 * The first index at or after `start` (bee's lookup) with no update, read
 * directly: the lookup lands short, and writing at a taken index is a lost
 * update. `readAt` as for confirmFeedHead; when it cannot say, this refuses
 * rather than guess, before anything is written.
 */
async function firstFreeIndex(start, readAt, maxWalk = FORWARD_WALK) {
  for (let i = start; i < start + maxWalk; i++) {
    let held;
    try {
      held = await readAt(i);
    } catch (e) {
      throw new Error(`Cannot tell whether scanner feed index ${i} is taken (${why(e)}). Nothing was written - re-run.`);
    }
    if (held === null) return i;
  }
  throw new Error(`More than ${maxWalk} scanner feed updates past bee's lookup at ${start}: refusing to guess where to write. Nothing was written.`);
}

module.exports = { confirmFeedHead, feedUpdateAddress, firstFreeIndex, FORWARD_WALK };

function getAllFilesRecursive(dir, baseDir = dir, fileList = []) {
  const files = fs.readdirSync(dir);
  files.forEach(file => {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      getAllFilesRecursive(filePath, baseDir, fileList);
    } else {
      const relativePath = path.relative(baseDir, filePath).split(path.sep).join('/');
      fileList.push(relativePath);
    }
  });
  return fileList;
}

if (require.main === module) (async () => {
  console.log('\nStarting Swarm Feed Upload (WoCo Scanner PWA)...\n');

  if (!FEED_PRIVATE_KEY || !/^0x[0-9a-fA-F]{64}$/.test(FEED_PRIVATE_KEY)) {
    console.error('ERROR: FEED_PRIVATE_KEY is not set correctly. Set it in scripts/.env');
    process.exit(1);
  }
  if (!POSTAGE_BATCH_ID || !/^[0-9a-fA-F]{64}$/.test(POSTAGE_BATCH_ID)) {
    console.error('ERROR: POSTAGE_BATCH_ID is not set correctly. Set it in scripts/.env');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(UPLOAD_DIR, 'index.html'))) {
    console.error(`ERROR: ${UPLOAD_DIR}/index.html does not exist. Run 'npm run build:scanner' first.`);
    process.exit(1);
  }

  // Open SSH tunnel if the proxy isn't already reachable at BEE_URL
  let sshTunnel = null;
  try {
    await axios.get(`${BEE_URL}/health`, { timeout: 2000, validateStatus: () => true });
    console.log(`Proxy already reachable at ${BEE_URL}`);
  } catch {
    console.log(`Opening SSH tunnel: ${SSH_HOST} → localhost:3000 ...`);
    sshTunnel = spawn('ssh', [
      '-NL', '3000:127.0.0.1:3000',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      SSH_HOST,
    ], { stdio: 'ignore' });
    sshTunnel.on('error', (err) => {
      console.error('SSH tunnel error:', err.message);
      process.exit(1);
    });
    let ready = false;
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        await axios.get(`${BEE_URL}/health`, { timeout: 2000, validateStatus: () => true });
        ready = true;
        break;
      } catch { /* keep waiting */ }
    }
    if (!ready) {
      sshTunnel.kill();
      console.error(`ERROR: SSH tunnel to ${SSH_HOST} failed to establish after 15s.`);
      process.exit(1);
    }
    console.log('SSH tunnel established.\n');
  }

  try {
    const uploadHeaders = UPLOAD_SECRET ? { 'x-upload-secret': UPLOAD_SECRET } : {};
    const bee = new Bee(BEE_URL, { headers: uploadHeaders });
    const signer = new PrivateKey(FEED_PRIVATE_KEY);
    const ownerObj = signer.publicKey().address();
    const ownerHex = ownerObj.toHex();
    // The server pins who may sign the scanner feed (scan.woco.eth answers only its
    // updates). A different key here would publish where the server never looks.
    const pinned = fs.readFileSync(path.resolve(__dirname, '../apps/server/src/lib/scanner/latest-build.ts'), 'utf8')
      .match(/SCANNER_FEED_OWNER = "([0-9a-f]{40})"/);
    if (!pinned || pinned[1] !== ownerHex.replace(/^0x/, '').toLowerCase()) {
      throw new Error(`this key (${ownerHex}) is not the scanner feed owner the server pins (${pinned ? pinned[1] : 'not found'}) - update SCANNER_FEED_OWNER in apps/server/src/lib/scanner/latest-build.ts and deploy the server first`);
    }
    const topic = Topic.fromString(FEED_TOPIC);

    console.log(`Bee: ${BEE_URL}`);
    console.log(`Feed Topic: ${FEED_TOPIC}`);
    console.log(`Feed Owner: ${ownerHex}\n`);

    const manifestState = await readJsonIfExists(MANIFEST_STATE);
    const stateProblem = manifestStateProblem(manifestState, ownerHex, topic.toString());
    if (stateProblem) throw new Error(`Not deploying: ${stateProblem}`);
    const stamps = (await axios.get(`${BEE_URL}/stamps`, { timeout: 15000 })).data?.stamps;
    const problems = batchProblems(stamps, { build: BUILD_BATCH_ID, core: POSTAGE_BATCH_ID });
    if (problems.length) throw new Error(`Not deploying:\n  - ${problems.join('\n  - ')}`);

    // 1) Upload dist-scanner/ as a collection
    const tarPath = path.resolve(__dirname, '../scanner.tar');
    const filesToInclude = getAllFilesRecursive(UPLOAD_DIR);
    console.log(`Creating tar from: ${UPLOAD_DIR} (${filesToInclude.length} files) ...`);
    await tar.create(
      { file: tarPath, cwd: UPLOAD_DIR, portable: true, gzip: false },
      filesToInclude,
    );
    const tarData = fs.readFileSync(tarPath);
    console.log(`Uploading tar (${tarData.length} bytes)...`);
    const resp = await axios.post(`${BEE_URL}/bzz`, tarData, {
      headers: {
        'Content-Type': 'application/x-tar',
        'Swarm-Postage-Batch-Id': BUILD_BATCH_ID,
        'Swarm-Index-Document': 'index.html',
        'Swarm-Error-Document': 'index.html',
        'Swarm-Collection': 'true',
        ...uploadHeaders,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    fs.unlinkSync(tarPath);
    const siteRef = resp.data.reference;
    console.log(`Content reference: ${siteRef}`);

    // 2) Create or reuse feed manifest
    await ensureDir(STATE_DIR);
    let manifestRef;
    if (manifestState?.manifestRef) {
      manifestRef = manifestState.manifestRef;
      console.log(`Using existing feed manifest: ${manifestRef}`);
    } else {
      console.log('Creating feed manifest (one-time)...');
      const manifestRefObj = await bee.createFeedManifest(POSTAGE_BATCH_ID, topic, ownerObj);
      manifestRef = manifestRefObj.toString();
      console.log(`Feed manifest created: ${manifestRef}`);
      await fs.promises.writeFile(
        MANIFEST_STATE,
        JSON.stringify({ manifestRef, owner: ownerHex, topic: topic.toString() }, null, 2),
      );
    }

    // 3) Update feed — same explicit-index rail as upload-to-swarm-feed.cjs
    // (bee-js auto-increment silently falls back to index 0 on transient errors,
    //  and uploadReference() is the only writer compatible with v1 manifests).
    console.log('Reading next feed index from bee...');
    let lookupIdx;
    const idxProbe = await axios.get(
      `${BEE_URL}/feeds/${ownerHex}/${topic.toString()}`,
      { maxRedirects: 0, validateStatus: () => true, responseType: 'arraybuffer', timeout: 15000 },
    );
    if (idxProbe.status === 200) {
      const nextHex = idxProbe.headers['swarm-feed-index-next'];
      if (!nextHex || !/^[0-9a-fA-F]+$/.test(nextHex)) {
        throw new Error(`bee returned 200 but no valid swarm-feed-index-next header: ${nextHex}`);
      }
      lookupIdx = Number(BigInt('0x' + nextHex));
    } else if (idxProbe.status === 404) {
      lookupIdx = 0;
    } else {
      throw new Error(`bee returned status ${idxProbe.status} when probing feed for next index`);
    }

    // The proxy serves /chunks only for whitelisted addresses, and both the walk
    // to a free index and the read-back after the write read updates there: the
    // window covers every index the walk can reach and the one after it.
    // Whitelisted BEFORE the write, as upload-to-swarm-feed.cjs does: a failure
    // here has written nothing.
    const reachable = Array.from({ length: FORWARD_WALK + 1 }, (_, k) => lookupIdx + k);
    const updateAddresses = reachable.map((i) => feedUpdateAddress(topic.toString(), i, ownerHex));
    const wl = await axios.post(`${BEE_URL}/admin/whitelist`, { hashes: updateAddresses }, {
      headers: { ...uploadHeaders, 'Content-Type': 'application/json' },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (wl.status !== 200) {
      throw new Error(`Could not whitelist feed updates ${lookupIdx}-${lookupIdx + FORWARD_WALK} on the gateway (HTTP ${wl.status}), so the write could not be verified. Nothing was written.`);
    }

    const reader = bee.makeFeedReader(topic, ownerHex);
    const readAt = async (i) => {
      try {
        // Checks the update is signed by the feed owner; the payload after the timestamp is the reference.
        return (await reader.download({ index: i })).payload.toHex();
      } catch (e) {
        if (e?.status === 404) return null;
        throw e;
      }
    };
    const nextIdx = await firstFreeIndex(lookupIdx, readAt);
    if (nextIdx !== lookupIdx) console.log(`bee's lookup said next index ${lookupIdx}, but ${lookupIdx}-${nextIdx - 1} are taken.`);
    console.log(`Next index: ${nextIdx}`);

    console.log('Updating feed (uploadReference / v1)...');
    const writer = bee.makeFeedWriter(topic, signer);
    await writer.uploadReference(POSTAGE_BATCH_ID, new Reference(siteRef), { index: nextIdx });

    // 4) Whitelist on the gateway (uploads via the proxy usually self-whitelist;
    //    this covers the manifest ref + belt-and-braces on the content ref).
    if (UPLOAD_SECRET) {
      try {
        await axios.post(`${BEE_URL}/admin/whitelist`, { hashes: [siteRef, manifestRef] }, {
          headers: { 'Content-Type': 'application/json', 'x-upload-secret': UPLOAD_SECRET },
          timeout: 10000,
        });
        console.log('Whitelisted content + manifest refs on gateway.');
      } catch (e) {
        console.warn('Whitelist call failed (non-fatal):', e?.message ?? e);
      }
    }

    // 5) Verify by reading the written index directly from the same bee, never the
    //    lookup: a lost update must fail the deploy, not report success.
    await confirmFeedHead(nextIdx, siteRef, readAt);
    console.log(`Scanner feed resolves to this build (feed index ${nextIdx}, read back directly).`);

    // 6) Save state
    const info = {
      timestamp: new Date().toISOString(),
      beeUrl: BEE_URL,
      owner: ownerHex,
      topicString: FEED_TOPIC,
      topicHex: topic.toString(),
      latestSiteReference: siteRef,
      manifestRef,
      scannerUrl: `${BEE_URL}/bzz/${manifestRef}/`,
      bzzContentUrl: `${BEE_URL}/bzz/${siteRef}/`,
    };
    await fs.promises.writeFile(INFO_STATE, JSON.stringify(info, null, 2));

    console.log('\n======================================================================');
    console.log('SCANNER UPLOAD COMPLETE');
    console.log('======================================================================\n');
    console.log(`Scanner URL (stable):  ${BEE_URL}/bzz/${manifestRef}/`);
    console.log(`Direct content:        ${BEE_URL}/bzz/${siteRef}/`);
    console.log('\nscan.woco.eth follows this feed through the CCIP gateway - no record to set.');
    console.log(`\nVITE_SCANNER_URL:      ${BEE_URL}/bzz/${manifestRef}`);
    console.log('(already expected in apps/web/.env.production — update if the manifest ever changes)\n');

  } catch (err) {
    console.error('Upload failed:', err?.message ?? err);
    if (err.response?.data) console.error('Response:', String(err.response.data).slice(0, 500));
    process.exit(1);
  } finally {
    if (sshTunnel) {
      sshTunnel.kill();
      console.log('SSH tunnel closed.');
    }
  }
})();
