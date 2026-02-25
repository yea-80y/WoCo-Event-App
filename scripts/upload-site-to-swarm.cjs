#!/usr/bin/env node

/**
 * Swarm Site Uploader for WoCo Site Builder
 *
 * Uploads the built site (apps/web/dist-site/) to Swarm, creating a
 * feed for updatable ENS content hashes.
 *
 * USAGE:
 *   npm run build:site     # Build the generated event site
 *   npm run upload:site    # Upload to Swarm
 *
 * PREREQUISITES:
 *   Create scripts/.env (gitignored) with:
 *     FEED_PRIVATE_KEY=0x<your-64-hex-char-key>
 *     SITE_POSTAGE_BATCH_ID=<your-batch-id>
 *     SITE_BEE_URL=http://localhost:1633    # Your Bee node API endpoint
 *     SITE_FEED_TOPIC=woco-site             # optional, default: woco-site
 */

const { Bee, PrivateKey, Topic, Reference } = require('@ethersphere/bee-js');
const fs = require('fs');
const path = require('path');
const tar = require('tar');
const axios = require('axios');

// Load scripts/.env (shared with main upload script)
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const BEE_URL = process.env.SITE_BEE_URL || 'http://localhost:1633';
const POSTAGE_BATCH_ID = process.env.SITE_POSTAGE_BATCH_ID || '';
const FEED_PRIVATE_KEY = process.env.FEED_PRIVATE_KEY || '';
const FEED_TOPIC = process.env.SITE_FEED_TOPIC || 'woco-site';

const UPLOAD_DIR = path.resolve(__dirname, '../apps/web/dist-site');

// Persisted state for reusing the same feed manifest across deployments
const STATE_DIR = path.resolve(__dirname, '../.swarm');
const SITE_MANIFEST_STATE = path.join(STATE_DIR, 'site-feed-manifest.json');

async function ensureDir(p) {
  await fs.promises.mkdir(p, { recursive: true });
}

async function readJsonIfExists(p) {
  try {
    return JSON.parse(await fs.promises.readFile(p, 'utf-8'));
  } catch {
    return null;
  }
}

function getAllFilesRecursive(dir, baseDir = dir, fileList = []) {
  const files = fs.readdirSync(dir);
  files.forEach((file) => {
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
  console.log('\nStarting Swarm Site Upload (WoCo Site Builder)...\n');

  if (!FEED_PRIVATE_KEY || !/^0x[0-9a-fA-F]{64}$/.test(FEED_PRIVATE_KEY)) {
    console.error('ERROR: FEED_PRIVATE_KEY is not set correctly in scripts/.env');
    console.error('       Expected: 0x followed by 64 hex characters');
    process.exit(1);
  }

  if (!POSTAGE_BATCH_ID) {
    console.error('ERROR: SITE_POSTAGE_BATCH_ID is not set in scripts/.env');
    process.exit(1);
  }

  if (!fs.existsSync(UPLOAD_DIR)) {
    console.error(`ERROR: ${UPLOAD_DIR} does not exist.`);
    console.error("       Run 'npm run build:site' first.");
    process.exit(1);
  }

  try {
    const bee = new Bee(BEE_URL);
    const signer = new PrivateKey(FEED_PRIVATE_KEY);
    const ownerObj = signer.publicKey().address();
    const ownerHex = ownerObj.toHex();
    const topic = Topic.fromString(FEED_TOPIC);

    console.log(`Bee:        ${BEE_URL}`);
    console.log(`Feed topic: ${FEED_TOPIC}`);
    console.log(`Owner:      ${ownerHex}\n`);

    // 1) Create tar from dist-site directory
    console.log(`Creating tar from: ${UPLOAD_DIR} ...`);
    const tarPath = path.resolve(__dirname, '../site-build.tar');
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
        'Swarm-Index-Document': 'site.html',
        'Swarm-Error-Document': 'site.html',
        'Swarm-Collection': 'true',
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    const siteRef = uploadResponse.data.reference;
    console.log(`Uploaded. Content hash: ${siteRef}`);

    fs.unlinkSync(tarPath);

    // 3) Create or reuse feed manifest
    await ensureDir(STATE_DIR);
    let manifestRef;
    const manifestState = await readJsonIfExists(SITE_MANIFEST_STATE);

    if (manifestState?.manifestRef) {
      manifestRef = manifestState.manifestRef;
      console.log(`Using existing feed manifest: ${manifestRef}`);
    } else {
      console.log('Creating feed manifest (one-time)...');
      const manifestRefObj = await bee.createFeedManifest(POSTAGE_BATCH_ID, topic, ownerObj);
      manifestRef = manifestRefObj.toString();
      console.log(`Feed manifest created: ${manifestRef}`);
      await fs.promises.writeFile(
        SITE_MANIFEST_STATE,
        JSON.stringify(
          { manifestRef, owner: ownerHex, topic: topic.toString(), feedTopic: FEED_TOPIC },
          null,
          2,
        ),
      );
    }

    // 4) Update feed to point at new site
    console.log('Updating feed...');
    const writer = bee.makeFeedWriter(topic, signer);
    await writer.upload(POSTAGE_BATCH_ID, new Reference(siteRef));

    // Wait for propagation
    await new Promise((r) => setTimeout(r, 3000));

    // Verify
    const reader = bee.makeFeedReader(topic, ownerObj);
    try {
      const feed = await reader.download();
      const index = Number(BigInt('0x' + Buffer.from(feed.feedIndex.bytes).toString('hex')));
      console.log(`Feed updated successfully! Index: ${index}`);
    } catch (e) {
      console.log(`Could not verify feed update: ${e.message}`);
    }

    // 5) Print results
    console.log('\n======================================================================');
    console.log('SITE UPLOAD COMPLETE');
    console.log('======================================================================\n');
    console.log(`Direct content hash:    ${siteRef}`);
    console.log(`Feed manifest (stable): ${manifestRef}\n`);
    console.log(`Swarm URLs:`);
    console.log(`  Direct:   ${BEE_URL}/bzz/${siteRef}/`);
    console.log(`  Via feed: ${BEE_URL}/bzz/${manifestRef}/\n`);
    console.log('Set your ENS contenthash to (use feed manifest for auto-updating):');
    console.log(`  bzz://${manifestRef}\n`);
    console.log('Or the direct content hash for a static pin:');
    console.log(`  bzz://${siteRef}\n`);

    // Save info
    const info = {
      timestamp: new Date().toISOString(),
      beeUrl: BEE_URL,
      feedTopic: FEED_TOPIC,
      owner: ownerHex,
      latestContentHash: siteRef,
      manifestRef,
    };
    await ensureDir(STATE_DIR);
    await fs.promises.writeFile(
      path.join(STATE_DIR, 'site-upload-info.json'),
      JSON.stringify(info, null, 2),
    );
  } catch (err) {
    console.error('Upload failed:', err?.message ?? err);
    if (err.response?.data) console.error('Response:', err.response.data);
    process.exit(1);
  }
})();
