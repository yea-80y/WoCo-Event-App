/**
 * Every bundle we publish is built from the laptop's node_modules, which a `git pull`
 * does not update (scripts/installed-deps.cjs). On 2026-11-02 the deploy checkout's
 * packages were two weeks behind package-lock.json and every frontend deploy since had
 * shipped older dependencies than CI tested. These builds now refuse first.
 *
 * MUTATION: drop a build from the list below, let a differing version through, or stop
 * reporting a missing package, and a case goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const { installedDepsProblems } = createRequire(import.meta.url)("../../../scripts/installed-deps.cjs") as {
  installedDepsProblems: (lock: unknown, readVersion: (dir: string) => string | null) => string[];
};

const lock = {
  packages: {
    "": { name: "woco", version: "0.0.0" },
    "node_modules/a": { version: "1.0.0" },
    "apps/web/node_modules/@web3auth/modal": { version: "11.4.3" },
    "node_modules/opt": { version: "2.0.0", optional: true },
    "node_modules/peer": { version: "3.0.0", peer: true },
    "node_modules/@woco/web": { resolved: "apps/web", link: true },
    "node_modules/dev-tool": { version: "4.0.0", dev: true },
  },
};

test("installed exactly as locked: no problems", () => {
  const installed: Record<string, string> = {
    "node_modules/a": "1.0.0",
    "apps/web/node_modules/@web3auth/modal": "11.4.3",
    "node_modules/dev-tool": "4.0.0",
  };
  assert.deepEqual(installedDepsProblems(lock, (d) => installed[d] ?? null), []);
});

test("a stale install is refused: older version, and a missing package, dev ones included", () => {
  const installed: Record<string, string> = { "node_modules/a": "1.0.0", "apps/web/node_modules/@web3auth/modal": "11.4.2" };
  assert.deepEqual(installedDepsProblems(lock, (d) => installed[d] ?? null), [
    "apps/web/node_modules/@web3auth/modal: installed 11.4.2, lockfile 11.4.3",
    "node_modules/dev-tool: missing (lockfile 4.0.0)",
  ]);
});

test("optional, peer, linked and root entries are never required", () => {
  const all: Record<string, string> = {
    "node_modules/a": "1.0.0",
    "apps/web/node_modules/@web3auth/modal": "11.4.3",
    "node_modules/dev-tool": "4.0.0",
  };
  const asked: string[] = [];
  installedDepsProblems(lock, (d) => (asked.push(d), all[d] ?? null));
  assert.deepEqual(asked.sort(), Object.keys(all).sort());
});

test("every build of something we publish checks the install first", () => {
  const scripts = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).scripts as Record<string, string>;
  for (const name of ["build:deploy", "build:scanner", "build:site", "build:multisite", "build:auth"]) {
    assert.match(scripts[name], /^node scripts\/installed-deps\.cjs && /, `${name} must check the installed packages first`);
  }
  assert.match(scripts.deploy, /^npm run build:deploy && /);
  assert.match(scripts["deploy:scanner"], /^npm run build:scanner && /);
});
