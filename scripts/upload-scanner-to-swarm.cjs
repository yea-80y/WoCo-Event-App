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
 * That URL never changes across deploys — set it as VITE_SCANNER_URL in
 * apps/web/.env.production so dashboard door-pass links point at it, and
 * (later) as the bzz:// content hash on scan.woco.eth.
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

require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const BEE_URL = process.env.BEE_URL || 'https://gateway.woco-net.com';
const POSTAGE_BATCH_ID = process.env.POSTAGE_BATCH_ID || '';
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

(async () => {
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
    const topic = Topic.fromString(FEED_TOPIC);

    console.log(`Bee: ${BEE_URL}`);
    console.log(`Feed Topic: ${FEED_TOPIC}`);
    console.log(`Feed Owner: ${ownerHex}\n`);

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
        'Swarm-Postage-Batch-Id': POSTAGE_BATCH_ID,
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
    const manifestState = await readJsonIfExists(MANIFEST_STATE);
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
    let nextIdx;
    const idxProbe = await axios.get(
      `${BEE_URL}/feeds/${ownerHex}/${topic.toString()}`,
      { maxRedirects: 0, validateStatus: () => true, responseType: 'arraybuffer', timeout: 15000 },
    );
    if (idxProbe.status === 200) {
      const nextHex = idxProbe.headers['swarm-feed-index-next'];
      if (!nextHex || !/^[0-9a-fA-F]+$/.test(nextHex)) {
        throw new Error(`bee returned 200 but no valid swarm-feed-index-next header: ${nextHex}`);
      }
      nextIdx = Number(BigInt('0x' + nextHex));
    } else if (idxProbe.status === 404) {
      nextIdx = 0;
    } else {
      throw new Error(`bee returned status ${idxProbe.status} when probing feed for next index`);
    }
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

    // 5) Verify — poll up to 5s for the feed to resolve to our siteRef
    let verifiedIndex = null;
    let verified = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const probe = await axios.get(
          `${BEE_URL}/feeds/${ownerHex}/${topic.toString()}`,
          { maxRedirects: 0, validateStatus: () => true, responseType: 'arraybuffer', timeout: 10000 },
        );
        if (probe.status !== 200) continue;
        const idxHex = probe.headers['swarm-feed-index'];
        const etag = probe.headers.etag?.replace(/"/g, '');
        if (idxHex) verifiedIndex = Number(BigInt('0x' + idxHex));
        if (verifiedIndex != null && verifiedIndex >= nextIdx && etag === siteRef) {
          verified = true;
          break;
        }
      } catch { /* keep polling */ }
    }

    if (verified) {
      console.log(`Feed updated successfully! Index: ${verifiedIndex}`);
    } else {
      console.log(
        `Wrote index ${nextIdx} (verify still cold after 5s — SOC chunk is durable; ` +
        `confirm: curl -I ${BEE_URL}/feeds/${ownerHex}/${topic.toString()})`,
      );
    }

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
    console.log(`\nFor ENS content hash:  bzz://${manifestRef}`);
    console.log('Set this on scan.woco.eth if/when the subname is created.');
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
