#!/usr/bin/env node
/**
 * Guarded server deploy — wraps STEP 1 of the runbook (#125).
 *
 * The deploy rsyncs a MUTABLE WORKING DIRECTORY, not a git ref. Whatever is in
 * the folder ships: committed or not, merged or not, reviewed or not, and
 * nothing checked. That is not hypothetical — on 2026-08-01 a parallel session
 * had uncommitted, actively-changing edits to the card-fee arithmetic in the
 * shared checkout, and the documented deploy would have shipped half-finished
 * money-path code. It was caught because the tree happened to be inspected
 * first. Procedure alone has not held; this is the mechanism.
 *
 * NO DEPLOY TARGET LIVES IN THIS FILE. The repo is public. Pass it in:
 *
 *   WOCO_DEPLOY_HOST=user@host WOCO_DEPLOY_PATH=/opt/woco \
 *     node scripts/deploy-server.mjs
 *
 *   --allow-dirty  deploy anyway (genuine hotfix). Still stamps honestly, so
 *                  /api/health reports the tree was dirty rather than implying
 *                  the commit shipped cleanly.
 *   --yes          skip the confirmation prompt.
 *   --dry-run      run every check and the rsync dry run, then stop.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const flags = new Set(process.argv.slice(2));
for (const f of flags) {
  if (!["--allow-dirty", "--yes", "-y", "--dry-run", "-n"].includes(f)) {
    console.error(`unknown flag: ${f}`);
    process.exit(2);
  }
}
const ALLOW_DIRTY = flags.has("--allow-dirty");
const ASSUME_YES = flags.has("--yes") || flags.has("-y");
const DRY_RUN = flags.has("--dry-run") || flags.has("-n");

const die = (msg) => {
  console.error(`REFUSING: ${msg}`);
  process.exit(1);
};
const git = (...args) => execFileSync("git", args, { encoding: "utf-8" }).trim();

const HOST = process.env.WOCO_DEPLOY_HOST;
const DEST = process.env.WOCO_DEPLOY_PATH;
if (!HOST) die("set WOCO_DEPLOY_HOST (see the private runbook)");
if (!DEST) die("set WOCO_DEPLOY_PATH (see the private runbook)");

process.chdir(git("rev-parse", "--show-toplevel"));

// ── 1. Not a linked worktree ────────────────────────────────────────────────
// A worktree does not carry the repo's untracked files — contracts/ (a nested
// repo), .swarm/, scripts/, deploy/ — so `--delete` reads them as removals. A
// dry run from one on 2026-08-01 showed 2124 deletions, 1669 of them
// contracts/. It was caught by -n and never executed. This is that catch, made
// automatic rather than remembered.
if (git("rev-parse", "--git-dir") !== git("rev-parse", "--git-common-dir")) {
  die(`this is a linked worktree (${process.cwd()}). Deploy from the canonical checkout.`);
}

// ── 2. Clean tree ───────────────────────────────────────────────────────────
const dirty = git("status", "--porcelain");
if (dirty && !ALLOW_DIRTY) {
  console.error(dirty);
  die("working tree is not clean. Commit, stash, or pass --allow-dirty for a genuine hotfix.");
}

// ── 3. Deploying merged code ────────────────────────────────────────────────
git("fetch", "--quiet", "origin", "main");
const head = git("rev-parse", "HEAD");
const originMain = git("rev-parse", "origin/main");
const branch = git("rev-parse", "--abbrev-ref", "HEAD");

if (!ALLOW_DIRTY) {
  if (head !== originMain) {
    die(`HEAD (${branch}, ${head.slice(0, 8)}) is not origin/main (${originMain.slice(0, 8)}). Merge first, or pass --allow-dirty.`);
  }
  // The same hazard from the other side: code that exists only here would ship,
  // and nobody could reproduce what production is running.
  if (git("log", "--oneline", "origin/main..HEAD")) {
    die("HEAD has commits not on origin/main. Push and merge them first.");
  }
}

// ── 4. Stamp what is about to ship ──────────────────────────────────────────
// Written AFTER the checks and BEFORE the rsync, from the SHA just verified, so
// it is an artefact of this run rather than state someone left lying around —
// which is what keeps the code and its label from being set by two separate
// actions. Rewritten on EVERY run including --allow-dirty: the failure to avoid
// is not a missing stamp but a stale one read as current. `.deploy-commit` is
// gitignored, and rsync carries it because rsync does not read .gitignore.
const stamp = dirty ? `${head}-dirty` : head;
writeFileSync(".deploy-commit", `${stamp}\n${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}\n`);

console.log("About to deploy:");
console.log(`  commit   ${git("log", "-1", "--oneline")}`);
console.log(`  branch   ${branch}`);
console.log(`  stamp    ${stamp}`);
console.log(`  target   ${HOST}:${DEST}/repo/`);
if (dirty) console.log(`  TREE IS DIRTY — ${dirty.split("\n").length} changed path(s) will ship`);

// The exclude list also protects RECEIVER-side files, which is what makes
// `--delete` safe here: the VM's dist-multisite and dist-site are volume-mounted
// into the container and are synced by their own step. Do not add the flag that
// deletes excluded paths as well — it overrides that protection and would take
// dist-multisite with it, breaking every published organiser site.
const RSYNC = [
  "-az", "--delete",
  "--exclude=node_modules", "--exclude=.git", "--exclude=dist",
  "--exclude=apps/web/dist-site", "--exclude=apps/web/dist-multisite",
  "--exclude=packages/embed/dist",
  "--exclude=contracts-stylus/like-aggregator/target",
];

// ── 5. Dry run, and read the deletion count ─────────────────────────────────
// The runbook says to always -n first and read the count. Doing it here means
// it cannot be skipped in a hurry.
console.log("\nDry run…");
const probe = spawnSync("rsync", [...RSYNC, "-n", "--itemize-changes", "./", `${HOST}:${DEST}/repo/`], { encoding: "utf-8" });
if (probe.status !== 0) die(`rsync dry run failed:\n${probe.stderr || probe.stdout}`);

const lines = probe.stdout.split("\n").filter(Boolean);
const removals = lines.filter((l) => l.startsWith("*deleting"));
console.log(`  ${lines.length - removals.length} path(s) to send, ${removals.length} to remove`);

if (removals.length) {
  console.log(removals.slice(0, 40).join("\n"));
  if (removals.length > 40) console.log(`  … and ${removals.length - 40} more`);
  console.log("\nRemovals are EXPECTED to be near zero from a clean canonical checkout.");
  console.log("A large count means the source is wrong — read the list before continuing.");
}

if (DRY_RUN) {
  console.log("Dry run only — stopping.");
  process.exit(0);
}

if (!ASSUME_YES) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const reply = await rl.question("Proceed? [y/N] ");
  rl.close();
  if (reply.trim().toLowerCase() !== "y") die("not confirmed.");
}

// ── 6. Deploy ───────────────────────────────────────────────────────────────
execFileSync("rsync", [...RSYNC, "./", `${HOST}:${DEST}/repo/`], { stdio: "inherit" });
// `up -d --build`, never `docker compose restart` — restart reuses the env the
// container was CREATED with and silently ignores env_file changes.
execFileSync("ssh", [HOST, `cd ${DEST} && docker compose up -d --build server`], { stdio: "inherit" });

console.log("\nDeployed. Verify the stamp reached production:");
console.log("  curl -s $PUBLIC_API_BASE/api/health | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"build\"])'");
console.log(`  expected commit: ${stamp}`);
