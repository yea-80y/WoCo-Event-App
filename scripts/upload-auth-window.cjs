#!/usr/bin/env node

/**
 * Uploader for the passkey sign-in window (apps/web/dist-auth/).
 *
 * NOT a feed, on purpose. `auth.woco.eth` resolves on L1 with its own resolver, and its
 * contenthash is this collection's IMMUTABLE reference, set by the owner's Safe - so a
 * change to the page that holds every passkey account is a Safe transaction, never a
 * deploy. This script only stamps the bytes and prints what the Safe transaction sets.
 *
 * Re-running it on the same build after a postage-batch swap re-stamps the same bytes
 * and prints the SAME reference: the L1 record stays right, nothing to sign.
 *
 * Refuses anything but a production window: the dev window builds into dist-auth-dev/,
 * and the checks below are the build's own (vite-plugins/auth-window.ts), repeated on
 * the exact bytes being sent.
 *
 * USAGE:
 *   npm run build:auth
 *   node scripts/upload-auth-window.cjs
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const UPLOAD_DIR = path.resolve(__dirname, '../apps/web/dist-auth');
const STATE_FILE = path.resolve(__dirname, '../.swarm/auth-window.json');

/** What a production window must say, byte for byte (packages/shared/src/auth/passkey-rp.ts). */
const PRODUCTION = {
  selfOrigin: '"https://auth.woco.eth.limo"',
  rpId: '"auth.woco.eth.limo"',
  openers: '["https://woco.eth.limo"]',
};

const sha256Base64 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('base64');

/** Why `index` is not a production sign-in window, or [] when it is. Pure. */
function windowProblems(index, notFound) {
  const problems = [];
  const script = /<script>([\s\S]*)<\/script>\s*<\/body>/.exec(index)?.[1];
  const style = /<style>([\s\S]*?)<\/style>/.exec(index)?.[1];
  const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(index)?.[1];
  if (!script || !style || !csp) return ['index.html has no inline script, style or CSP'];
  if (!csp.includes(`script-src 'sha256-${sha256Base64(script)}'`)) problems.push('the CSP does not pin the inline script');
  if (!csp.includes(`style-src 'sha256-${sha256Base64(style)}'`)) problems.push('the CSP does not pin the inline style');
  if (!csp.includes("connect-src 'none'") || !csp.includes("default-src 'none'")) problems.push('the CSP allows connections');
  for (const [what, literal] of Object.entries(PRODUCTION)) {
    if (!script.includes(literal)) problems.push(`the script does not name the production ${what} ${literal}`);
  }
  if (/localhost|127\.0\.0\.1/.test(index)) problems.push('it names localhost - a dev window');
  if (/<script/i.test(notFound)) problems.push('404.html carries a script');
  return problems;
}

/** The ENS contenthash for a Swarm reference (ENSIP-7: swarm-ns, CIDv1, swarm-manifest, keccak-256). */
function contenthashFor(ref) {
  if (!/^[0-9a-f]{64}$/.test(ref)) throw new Error(`not a Swarm reference: ${ref}`);
  return `0xe40101fa011b20${ref}`;
}

module.exports = { windowProblems, contenthashFor };

if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '.env') });
  const BEE_URL = process.env.BEE_URL || 'https://gateway.woco-net.com';
  const POSTAGE_BATCH_ID = process.env.POSTAGE_BATCH_ID || '';
  const UPLOAD_SECRET = process.env.UPLOAD_SECRET || '';
  const SSH_HOST = process.env.SSH_HOST || 'root@46.225.174.72';
  const axios = require('axios');
  const tar = require('tar');

  (async () => {
    const index = fs.readFileSync(path.join(UPLOAD_DIR, 'index.html'), 'utf8');
    const notFound = fs.readFileSync(path.join(UPLOAD_DIR, '404.html'), 'utf8');
    const problems = windowProblems(index, notFound);
    if (problems.length) {
      console.error(`REFUSED - not a production sign-in window:\n  - ${problems.join('\n  - ')}`);
      process.exit(1);
    }
    if (!/^[0-9a-fA-F]{64}$/.test(POSTAGE_BATCH_ID)) {
      console.error('ERROR: POSTAGE_BATCH_ID is not set correctly. Set it in scripts/.env');
      process.exit(1);
    }

    let tunnel = null;
    try {
      await axios.get(`${BEE_URL}/health`, { timeout: 2000, validateStatus: () => true });
    } catch {
      console.log(`Opening SSH tunnel: ${SSH_HOST} -> localhost:3000 ...`);
      tunnel = spawn('ssh', ['-NL', '3000:127.0.0.1:3000', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', SSH_HOST], { stdio: 'ignore' });
      let ready = false;
      for (let i = 0; i < 15 && !ready; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        ready = await axios.get(`${BEE_URL}/health`, { timeout: 2000, validateStatus: () => true }).then(() => true, () => false);
      }
      if (!ready) {
        tunnel.kill();
        console.error(`ERROR: SSH tunnel to ${SSH_HOST} failed to establish after 15s.`);
        process.exit(1);
      }
    }

    try {
      const auth = UPLOAD_SECRET ? { 'x-upload-secret': UPLOAD_SECRET } : {};
      const chunks = [];
      await new Promise((resolve, reject) => {
        tar.create({ cwd: UPLOAD_DIR, portable: true, gzip: false }, ['index.html', '404.html'])
          .on('data', (c) => chunks.push(c))
          .on('end', resolve)
          .on('error', reject);
      });
      const resp = await axios.post(`${BEE_URL}/bzz`, Buffer.concat(chunks), {
        headers: {
          'Content-Type': 'application/x-tar',
          'Swarm-Postage-Batch-Id': POSTAGE_BATCH_ID,
          'Swarm-Index-Document': 'index.html',
          'Swarm-Error-Document': '404.html',
          'Swarm-Collection': 'true',
          ...auth,
        },
      });
      const ref = String(resp.data.reference).toLowerCase();

      // Read back what a browser will be served: the page itself, and the error page
      // for any other path (never the app, as app.woco.eth.limo once did).
      const page = await axios.get(`${BEE_URL}/bzz/${ref}/`, { responseType: 'text', headers: auth });
      if (page.data !== index) throw new Error('the uploaded index.html does not read back byte for byte');
      const missing = await axios.get(`${BEE_URL}/bzz/${ref}/no-such-page`, { responseType: 'text', headers: auth, validateStatus: () => true });
      if (!String(missing.data).includes('Nothing here')) throw new Error('an unknown path is not answered with 404.html');

      const previous = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : null;
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      const state = { ref, contenthash: contenthashFor(ref), uploadedAt: new Date().toISOString(), batch: POSTAGE_BATCH_ID };
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

      console.log(`\nSign-in window reference: ${ref}`);
      console.log(`ENS contenthash:          ${state.contenthash}`);
      if (previous && previous.ref !== ref) {
        console.log(`\nCHANGED from ${previous.ref}: auth.woco.eth needs a Safe transaction setting the contenthash above.`);
      } else if (previous) {
        console.log('\nSame bytes as the last upload: re-stamped, no Safe transaction needed.');
      }
    } finally {
      tunnel?.kill();
    }
  })().catch((e) => {
    console.error('Upload failed:', e.message);
    process.exit(1);
  });
}
