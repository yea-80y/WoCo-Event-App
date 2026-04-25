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

  try {
    const bee = new Bee(BEE_URL);
    const signer = new PrivateKey(FEED_PRIVATE_KEY);
    const ownerObj = signer.publicKey().address();
    const ownerHex = ownerObj.toHex();
    const topic = Topic.fromString(FEED_TOPIC);

    console.log(`Bee: ${BEE_URL}`);
    console.log(`Feed Topic: ${FEED_TOPIC}`);
    console.log(`Feed Owner: ${ownerHex}\n`);

    // 1) Create tar from dist directory
    console.log(`Creating tar from: ${UPLOAD_DIR} ...`);
    const tarPath = path.resolve(__dirname, '../site.tar');
    const filesToInclude = getAllFilesRecursive(UPLOAD_DIR);

    await tar.create(
      { file: tarPath, cwd: UPLOAD_DIR, portable: true, gzip: false },
      filesToInclude,
    );

    const tarData = fs.readFileSync(tarPath);
    console.log(`Uploading tar (${tarData.length} bytes)...`);

    // 2) Upload to Swarm as collection
    const uploadResponse = await axios.post(`${BEE_URL}/bzz`, tarData, {
      headers: {
        'Content-Type': 'application/x-tar',
        'Swarm-Postage-Batch-Id': POSTAGE_BATCH_ID,
        'Swarm-Index-Document': 'index.html',
        'Swarm-Error-Document': 'index.html',
        'Swarm-Collection': 'true',
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    const siteRef = uploadResponse.data.reference;
    console.log(`Uploaded. Reference: ${siteRef}`);

    // Clean up tar
    fs.unlinkSync(tarPath);

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
    // IMPORTANT: bee-js v11 has THREE upload methods on FeedWriter:
    //   - upload()          — DOES NOT correctly write a reference; writes 768-byte
    //                         garbage that the manifest cannot resolve. Avoid.
    //   - uploadPayload()   — writes raw bytes as a v2-format feed entry; the
    //                         old createFeedManifest()-style manifests can't resolve v2.
    //   - uploadReference() — writes a Reference as a v1-format feed entry; this is
    //                         what createFeedManifest() expects. USE THIS.
    // If you switch to v2 feeds you'll need to recreate the manifest as well.
    console.log('Updating feed (uploadReference / v1)...');
    const writer = bee.makeFeedWriter(topic, signer);
    await writer.uploadReference(POSTAGE_BATCH_ID, new Reference(siteRef));

    // Verify — poll until proxy serves the new index (bee-proxy read-cache lag
    // can run 5–8s on a busy node; the old fixed 3s wait was unreliable).
    const reader = bee.makeFeedReader(topic, ownerObj);
    let verifiedIndex = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const feed = await reader.download();
        verifiedIndex = Number(BigInt('0x' + Buffer.from(feed.feedIndex.bytes).toString('hex')));
        // Stop polling once the latest etag matches our siteRef — confirms
        // the proxy is serving our new write, not a stale prior index.
        const probe = await axios.get(
          `${BEE_URL}/feeds/${ownerHex}/${topic.toString()}`,
          { maxRedirects: 0, validateStatus: () => true },
        );
        if (probe.headers.etag?.replace(/"/g, '') === siteRef) break;
      } catch { /* keep polling */ }
    }
    if (verifiedIndex != null) {
      console.log(`Feed updated successfully! Index: ${verifiedIndex}`);
    } else {
      console.log('Could not verify feed update (proxy still cold) — check manually with curl /feeds/{owner}/{topic}');
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
  }
})();
