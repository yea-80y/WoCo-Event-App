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

const { Bee, PrivateKey, Topic } = require('@ethersphere/bee-js');
const fs = require('fs');
const path = require('path');
const tar = require('tar');
const axios = require('axios');

// ===== CONFIG =====
const BEE_URL = 'https://gateway.woco-net.com';
const POSTAGE_BATCH_ID = '10385383779bc425047a1c9023fdb86b6873136ecccd52df9c10251c0991088b';

// Feed key loaded from scripts/.env (gitignored)
// Create scripts/.env with: FEED_PRIVATE_KEY=0x<your-key>
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const FEED_PRIVATE_KEY = process.env.FEED_PRIVATE_KEY || '';
const FEED_TOPIC = 'woco-events';
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
    console.error('ERROR: FEED_PRIVATE_KEY is not set correctly.');
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
    console.log('Updating feed...');
    const writer = bee.makeFeedWriter(topic, signer);
    await writer.upload(POSTAGE_BATCH_ID, siteRef);

    // Wait for propagation
    await new Promise(r => setTimeout(r, 2000));

    // Verify
    const reader = bee.makeFeedReader(topic, ownerObj);
    try {
      const feed = await reader.download();
      const refHex = typeof feed.reference.toHex === 'function'
        ? feed.reference.toHex()
        : String(feed.reference);
      if (refHex.toLowerCase() === siteRef.toLowerCase()) {
        console.log('Feed updated successfully!');
      } else {
        console.log(`WARNING: Feed reference mismatch. Expected: ${siteRef}, Got: ${refHex}`);
      }
    } catch (e) {
      console.log(`Could not verify feed update: ${e.message}`);
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
