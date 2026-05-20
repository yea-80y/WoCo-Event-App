#!/usr/bin/env node

/**
 * Swarm Feed Uploader for WoCo Events App
 *
 * Uploads the built Vite site to a Swarm feed.
 * Feed gives a permanent address for ENS — content updates
 * without changing the ENS content hash.
 *
 * USAGE:
 *   npm run build:deploy   # Build the frontend
 *   npm run upload:swarm   # Upload to Swarm
 *   -- or --
 *   npm run deploy          # Both in one step
 *
 * PREREQUISITES:
 *   npm install @ethersphere/bee-js tar axios
 *   (run from the monorepo root)
 */

const { Bee, PrivateKey, Topic, Reference } = require('@ethersphere/bee-js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const tar = require('tar');
const axios = require('axios');

// ===== CONFIG =====
// All secrets loaded from scripts/.env (gitignored)
// Create scripts/.env with:
//   FEED_PRIVATE_KEY=0x<your-key>
//   POSTAGE_BATCH_ID=<your-batch-id>
//   BEE_URL=https://gateway.woco-net.com  (optional, defaults to gateway.woco-net.com)
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const BEE_URL = process.env.BEE_URL || 'https://gateway.woco-net.com';
const POSTAGE_BATCH_ID = process.env.POSTAGE_BATCH_ID || '';
const FEED_PRIVATE_KEY = process.env.FEED_PRIVATE_KEY || '';
const UPLOAD_SECRET = process.env.UPLOAD_SECRET || '';
const SSH_HOST = process.env.SSH_HOST || 'root@46.225.174.72';
const FEED_TOPIC = 'woco-events-v1';
const UPLOAD_DIR = path.resolve(__dirname, '../apps/web/dist');

// Persisted state so we reuse the same manifest every time
const STATE_DIR = path.resolve(__dirname, '../.swarm');
const MANIFEST_STATE = path.join(STATE_DIR, 'feed-manifest.json');
const INFO_STATE = path.join(STATE_DIR, 'swarm-feed-info.json');

// ===== HELPERS =====
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
  console.log('\nStarting Swarm Feed Upload (WoCo Events)...\n');

  if (!FEED_PRIVATE_KEY || !/^0x[0-9a-fA-F]{64}$/.test(FEED_PRIVATE_KEY)) {
    console.error('ERROR: FEED_PRIVATE_KEY is not set correctly. Set it in scripts/.env');
    process.exit(1);
  }

  if (!POSTAGE_BATCH_ID || !/^[0-9a-fA-F]{64}$/.test(POSTAGE_BATCH_ID)) {
    console.error('ERROR: POSTAGE_BATCH_ID is not set correctly. Set it in scripts/.env');
    process.exit(1);
  }

  if (!fs.existsSync(UPLOAD_DIR)) {
    console.error(`ERROR: ${UPLOAD_DIR} does not exist. Run 'npm run build:deploy' first.`);
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

    // Two-pass upload so the served index.html carries an absolute <base href>
    // pointing at our fast gateway. Without this, woco.eth.limo serves the bundle
    // and the browser fetches every JS/CSS chunk from eth.limo's content path
    // (slow, outside our infra). With it, only the 1.2KB HTML comes from there;
    // assets resolve to https://gateway.woco-net.com/bzz/{assetsRef}/... which
    // hits our 24h-cached registry path.
    //
    // Pass 1 uploads dist/ verbatim to get assetsRef (the hash assets live under).
    // Pass 2 patches index.html with <base href=".../{assetsRef}/"> and re-uploads.
    // Asset chunks dedupe in bee, so pass 2 only writes the manifest + new HTML.
    const tarPath = path.resolve(__dirname, '../site.tar');
    const filesToInclude = getAllFilesRecursive(UPLOAD_DIR);
    const indexPath = path.join(UPLOAD_DIR, 'index.html');
    const indexOriginal = fs.readFileSync(indexPath, 'utf-8');

    async function uploadDist(label) {
      console.log(`[${label}] Creating tar from: ${UPLOAD_DIR} ...`);
      await tar.create(
        { file: tarPath, cwd: UPLOAD_DIR, portable: true, gzip: false },
        filesToInclude,
      );
      const tarData = fs.readFileSync(tarPath);
      console.log(`[${label}] Uploading tar (${tarData.length} bytes)...`);
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
      const ref = resp.data.reference;
      console.log(`[${label}] Reference: ${ref}`);
      return ref;
    }

    let siteRef;
    try {
      // Pass 1: assets live under this ref
      const assetsRef = await uploadDist('pass1');

      // Patch index.html with absolute <base href> → fast gateway
      const baseTag = `<base href="https://gateway.woco-net.com/bzz/${assetsRef}/">`;
      const patched = indexOriginal.replace(/<head>/i, `<head>\n    ${baseTag}`);
      if (patched === indexOriginal) {
        throw new Error('Could not inject <base href> — no <head> tag found in dist/index.html');
      }
      fs.writeFileSync(indexPath, patched);
      console.log(`Injected <base href="https://gateway.woco-net.com/bzz/${assetsRef}/"> into index.html`);

      // Pass 2: this ref is what the feed points to. Browser loads its index.html,
      // then base-href redirects every relative asset fetch to assetsRef on our gateway.
      siteRef = await uploadDist('pass2');
    } finally {
      // Restore unpatched index.html so the build tree isn't dirty
      fs.writeFileSync(indexPath, indexOriginal);
    }

    // 3) Create or reuse feed manifest
    await ensureDir(STATE_DIR);
    let manifestRef;
    const manifestState = await readJsonIfExists(MANIFEST_STATE);

    if (manifestState?.manifestRef) {
      manifestRef = manifestState.manifestRef;
      console.log(`Using existing feed manifest: ${manifestRef}`);
    } else {
      console.log('Creating feed manifest (one-time)...');
      const manifestRefObj = await bee.createFeedManifest(
        POSTAGE_BATCH_ID, topic, ownerObj,
      );
      manifestRef = manifestRefObj.toString();
      console.log(`Feed manifest created: ${manifestRef}`);
      await fs.promises.writeFile(
        MANIFEST_STATE,
        JSON.stringify({ manifestRef, owner: ownerHex, topic: topic.toString() }, null, 2),
      );
    }

    // 4) Update feed to point at new site
    //
    // Pass an explicit `index` to uploadReference(). bee-js v11's auto-increment
    // path (`findNextIndex` in node_modules/@ethersphere/bee-js/dist/cjs/feed/index.js)
    // catches BeeResponseError from its internal GET /feeds/{owner}/{topic} and
    // SILENTLY falls back to `FeedIndex.fromBigInt(0n)`. On any transient bee
    // error that fallback overwrites the SOC for index 0 while sequence lookup
    // keeps returning the highest existing index — feed appears frozen, no
    // exception surfaces. Reading `swarm-feed-index-next` directly is the
    // documented Swarm way (https://docs.ethswarm.org/api#tag/Feed) and avoids
    // the silent fallback entirely.
    //
    // bee-js v11 has three writer methods; uploadReference() is the only one
    // compatible with the v1 manifest produced by createFeedManifest():
    //   - upload(stamp, ref) — wrong v1 payload format
    //   - uploadPayload()    — writes v2-format, v1 manifests can't resolve
    //   - uploadReference()  — writes v1 timestamp+ref, USE THIS
    console.log('Reading next feed index from bee...');
    let nextIdx;
    const idxProbe = await axios.get(
      `${BEE_URL}/feeds/${ownerHex}/${topic.toString()}`,
      {
        maxRedirects: 0,
        validateStatus: () => true,
        responseType: 'arraybuffer',
        timeout: 15000,
      },
    );
    if (idxProbe.status === 200) {
      const nextHex = idxProbe.headers['swarm-feed-index-next'];
      if (!nextHex || !/^[0-9a-fA-F]+$/.test(nextHex)) {
        throw new Error(`bee returned 200 but no valid swarm-feed-index-next header: ${nextHex}`);
      }
      nextIdx = Number(BigInt('0x' + nextHex));
    } else if (idxProbe.status === 404) {
      // Fresh feed (manifest exists but no updates yet)
      nextIdx = 0;
    } else {
      throw new Error(`bee returned status ${idxProbe.status} when probing feed for next index`);
    }
    console.log(`Next index: ${nextIdx}`);

    console.log('Updating feed (uploadReference / v1)...');
    const writer = bee.makeFeedWriter(topic, signer);
    await writer.uploadReference(
      POSTAGE_BATCH_ID,
      new Reference(siteRef),
      { index: nextIdx },
    );

    // Verify — poll up to 5s for bee to resolve the feed to our siteRef. The
    // SOC POST already returned 201 above (chunk durably written); this just
    // confirms sequence lookup has caught up. Exit early on the first match
    // so happy-path uploads complete in ~1s of verify time.
    let verifiedIndex = null;
    let verified = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const probe = await axios.get(
          `${BEE_URL}/feeds/${ownerHex}/${topic.toString()}`,
          {
            maxRedirects: 0,
            validateStatus: () => true,
            responseType: 'arraybuffer',
            timeout: 10000,
          },
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
      // SOC chunk was accepted (POST returned 201); sequence lookup just
      // hasn't caught up yet. The deploy is durable — surface a hint, don't
      // fail the run.
      console.log(
        `Wrote index ${nextIdx} (verify still cold after 5s — SOC chunk is durable; ` +
        `confirm: curl -I ${BEE_URL}/feeds/${ownerHex}/${topic.toString()})`,
      );
    }

    // 5) Save state
    const info = {
      timestamp: new Date().toISOString(),
      beeUrl: BEE_URL,
      owner: ownerHex,
      topicString: FEED_TOPIC,
      topicHex: topic.toString(),
      latestSiteReference: siteRef,
      manifestRef,
      bzzManifestUrl: `${BEE_URL}/bzz/${manifestRef}/`,
      bzzContentUrl: `${BEE_URL}/bzz/${siteRef}/`,
    };
    await fs.promises.writeFile(INFO_STATE, JSON.stringify(info, null, 2));

    console.log('\n======================================================================');
    console.log('UPLOAD COMPLETE');
    console.log('======================================================================\n');
    console.log(`Feed manifest (stable): ${BEE_URL}/bzz/${manifestRef}/`);
    console.log(`Direct content:         ${BEE_URL}/bzz/${siteRef}/`);
    console.log(`\nFor ENS content hash:   bzz://${manifestRef}`);
    console.log('Set this on events.woco.eth in the ENS manager.\n');

  } catch (err) {
    console.error('Upload failed:', err?.message ?? err);
    if (err.response?.data) console.error('Response:', err.response.data);
    process.exit(1);
  } finally {
    if (sshTunnel) {
      sshTunnel.kill();
      console.log('SSH tunnel closed.');
    }
  }
})();
