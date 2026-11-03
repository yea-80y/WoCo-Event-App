/**
 * Refuses to build anything we publish from packages that are not the ones
 * package-lock.json names.
 *
 * Every frontend bundle (app, scanner, sign-in window, event pages, organiser
 * sites) is built on this laptop from its node_modules, not from a clean install.
 * A `git pull` updates package-lock.json and leaves node_modules as it was, so a
 * merged dependency bump reaches CI (which runs `npm ci`) but not the bundle we
 * upload. On 2026-11-02 the main checkout had last been installed on 10-18: every
 * frontend deploy since shipped 67 older packages than CI tested (Web3Auth 11.4.2
 * for 11.4.3, ZeroDev SDK 5.5.10 for 5.5.11), and nothing said so.
 *
 *   node scripts/installed-deps.cjs     exit 1, with the fix, when they differ
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * Packages whose installed version is not the lockfile's, or that are missing.
 * Optional and peer entries are skipped: they are legitimately absent on a
 * platform they do not apply to. `readVersion(dir)` returns the installed
 * package.json version, or null when there is none.
 */
function installedDepsProblems(lock, readVersion) {
  const packages = (lock && lock.packages) || {};
  const problems = [];
  for (const [dir, meta] of Object.entries(packages)) {
    if (!dir || !dir.includes('node_modules/') || !meta || meta.link || !meta.version) continue;
    if (meta.optional || meta.peer) continue;
    const installed = readVersion(dir);
    if (installed === null) problems.push(`${dir}: missing (lockfile ${meta.version})`);
    else if (installed !== meta.version) problems.push(`${dir}: installed ${installed}, lockfile ${meta.version}`);
  }
  return problems;
}

function main(root) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const readVersion = (dir) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8')).version ?? null;
    } catch {
      return null;
    }
  };
  const problems = installedDepsProblems(lock, readVersion);
  if (problems.length === 0) return 0;
  console.error(`\nREFUSED: ${problems.length} installed package(s) differ from package-lock.json, so this build would not be what CI tested:`);
  for (const p of problems.slice(0, 15)) console.error(`  ${p}`);
  if (problems.length > 15) console.error(`  ... and ${problems.length - 15} more`);
  console.error('\nRun `npm ci` in this checkout, then build again.\n');
  return 1;
}

if (require.main === module) process.exit(main(path.resolve(__dirname, '..')));

module.exports = { installedDepsProblems };
