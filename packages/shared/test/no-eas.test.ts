/**
 * The Ethereum Attestation Service is gone from the platform and must not come
 * back (#476, 2026-09-13).
 *
 * The referral campaign and the cohort badges were the last EAS users. They are
 * signed Swarm records now - `woco.referral.v1`, `woco.referral-confirmation.v1`
 * and `woco.badge.v1` in `packages/shared/src/campaign/records.ts`, written by
 * the campaign issuer key and read straight from feeds. What was deleted with
 * the old rail: two Arb Sepolia schemas, a delegated-attest EIP-712 payload the
 * server relayed and paid gas for, a `.data/referrals.json` projection, and a
 * scoped ZeroDev session key on every passkey device whose only permission was
 * `attest`/`revoke` on the EAS contract.
 *
 * WHY A RATCHET AND NOT A REVIEW. The deletion removed the ONE on-chain write
 * the platform still made for a social fact, and the ONE device-resident key
 * that could sign without a gesture. Both are the kind of thing that comes back
 * by accident: a stale doc, an old branch, a copied helper. This test is what
 * turns "we deleted it" into a property CI keeps true.
 *
 * SOURCE SCAN, deliberately. The property is "no module in the tree reaches
 * that rail", which is a fact about the import graph and about which files
 * exist. Nothing observable at runtime can assert the absence of a file.
 *
 * WHAT IT DOES NOT FORBID: the bare word "EAS" in prose. Several comments name
 * the retired rail on purpose - `social/types.ts`, `profile/label-cache.ts`,
 * `event/snapshot.ts` - to say what a thing is NOT, and that history is worth
 * keeping. Only the machinery is banned: the identifiers, the storage slot and
 * the import paths.
 *
 * MUTATION: re-add `packages/shared/src/campaign/eas.ts`, declare any
 * `EAS_*` constant, name `WOCO_AA_EAS_SESSION`, or import from a `eas/`
 * directory anywhere under the scanned roots, and this goes red. The last test
 * here proves that by planting the artefact and checking the scan finds it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The roots whose source must be free of the rail. */
const SRC_ROOTS = [
  "packages/shared/src",
  "apps/web/src",
  "apps/server/src",
  "apps/server/scripts",
];

/** Paths that must not exist at all. */
const MUST_BE_GONE = [
  "apps/web/src/lib/eas",
  "apps/web/src/lib/eas/attest-referral.ts",
  "apps/web/src/lib/eas/eas-abi.ts",
  "packages/shared/src/campaign/eas.ts",
  "packages/shared/src/campaign/types.ts",
  "packages/shared/src/campaign/delegation.ts",
  "apps/server/src/lib/campaign/eas-campaign.ts",
  "apps/server/src/lib/campaign/referral-store.ts",
  "apps/server/scripts/register-campaign-schemas.ts",
];

/**
 * Every way the rail shows up in source. Each is machinery, not prose: a
 * constant the contract addresses lived in, the session key's own vocabulary,
 * the delegated-attest entry point, the IndexedDB slot, and the npm namespace.
 */
const BANNED: Array<{ re: RegExp; what: string }> = [
  { re: /\bEAS_[A-Z_]+\b/, what: "an EAS_* constant" },
  { re: /\bEas(Session|Attest|Delegat)/, what: "an EAS session/attest/delegation identifier" },
  { re: /\battestByDelegation\b/, what: "the delegated-attest relay call" },
  { re: /\bWOCO_AA_EAS_SESSION\b/, what: "the EAS session key's storage slot" },
  { re: /ethereum-attestation/, what: "the EAS package namespace" },
];

/** An import specifier that resolves into the deleted `eas` module. */
function specifierNamesTheRail(spec: string): boolean {
  return /\/eas\//.test(spec) || /\/eas\.(js|ts)$/.test(spec);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|svelte|js|mjs|cjs)$/.test(name)) out.push(full);
  }
  return out;
}

/** Read every scannable file under `roots` (repo-relative, or absolute). */
function collect(roots: string[] = SRC_ROOTS): Array<{ rel: string; text: string }> {
  // resolve, not join: an absolute root (the mutation probe's temp directory)
  // must stand on its own rather than be appended to the repo root.
  return roots.flatMap((r) => walk(resolve(ROOT, r))).map((full) => ({
    rel: relative(ROOT, full).split("\\").join("/"),
    text: readFileSync(full, "utf-8"),
  }));
}

/** Every module specifier a file names, static or dynamic. */
function specifiers(text: string): string[] {
  const out: string[] = [];
  for (const re of [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /^\s*import\s+["']([^"']+)["']/gm,
  ]) {
    for (const m of text.matchAll(re)) out.push(m[1]!);
  }
  return out;
}

/** Every offence in the given files, as human-readable lines. */
function scan(files: Array<{ rel: string; text: string }>): string[] {
  const offences: string[] = [];
  for (const { rel, text } of files) {
    for (const { re, what } of BANNED) {
      const hit = text.match(re);
      if (hit) offences.push(`${rel}: ${what} (${hit[0]})`);
    }
    for (const spec of specifiers(text)) {
      if (specifierNamesTheRail(spec)) offences.push(`${rel} → ${spec}`);
    }
  }
  return offences;
}

const FILES = collect();

test("the scan actually reaches every source root", () => {
  // Without this, a moved directory would empty the walk and every assertion
  // below would pass vacuously — the classic way a source ratchet stops guarding
  // anything while staying green.
  // apps/server/scripts is much the smallest root, so it is the one this floor
  // is really sized for; if it ever shrinks past 20 legitimately, lower the
  // floor deliberately rather than deleting the guard.
  for (const r of SRC_ROOTS) {
    const n = FILES.filter((f) => f.rel.startsWith(`${r}/`)).length;
    assert.ok(n > 20, `${r} contributed only ${n} files — the walk is not reaching it`);
  }
  assert.ok(FILES.length > 500, `the walk found only ${FILES.length} files in total`);
});

test("nothing the rail lived in still exists", () => {
  const present = MUST_BE_GONE.filter((p) => existsSync(join(ROOT, p)));
  assert.deepEqual(present, [], "the EAS referral/badge rail was deleted (#476)");
});

test("no source file reaches EAS", () => {
  assert.deepEqual(
    scan(FILES),
    [],
    "referrals and badges are signed Swarm records (campaign/records.ts) — #476",
  );
});

test("the ratchet catches the artefact it exists to catch", () => {
  // A green ratchet proves nothing unless it can go red. Plant the exact thing
  // the deletion removed — a module under `lib/` importing the EAS ABI — and
  // check the SAME walk/collect/scan pipeline reports it.
  //
  // In a throwaway directory, NOT under apps/web/src: half a dozen other source
  // ratchets walk these roots, `node --test` runs the files concurrently, and a
  // probe that appears and vanishes mid-walk crashes whichever of them listed it
  // a moment before reading it. Writing it into the real tree did exactly that
  // here — another ratchet in this same directory died with ENOENT.
  const tmp = mkdtempSync(join(tmpdir(), "woco-eas-ratchet-"));
  try {
    mkdirSync(join(tmp, "lib"), { recursive: true });
    writeFileSync(join(tmp, "lib", "probe.ts"), 'import "../eas/eas-abi.js";\n');
    const offences = scan(collect([tmp]));
    assert.deepEqual(
      offences.map((o) => o.split(" → ")[1]),
      ["../eas/eas-abi.js"],
      "the scan missed the planted artefact",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
