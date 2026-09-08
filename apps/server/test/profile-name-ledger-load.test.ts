/**
 * What happens when `profile-names.json` exists but will not parse (#485).
 *
 * The ledger fails OPEN by design — an empty ledger resets every rename
 * cooldown and switches the profile-name refusal off until each account
 * re-binds — and that is the right direction: failing closed would lock every
 * organiser out of stamping any name after a disk fault. But an empty ledger is
 * ALSO the normal first boot, so the two were indistinguishable: a corrupt file
 * loaded as `{}`, said nothing, and the next bind persisted the empty map
 * straight over the damaged bytes. The reset became permanent and the evidence
 * was gone.
 *
 * Three things are pinned here, and only the middle one is about the data:
 *   · the failure is LOUD (a `[name-ledger]` error), not a silent empty map;
 *   · the unreadable file is renamed ASIDE before anything can overwrite it;
 *   · `/api/health` carries the flag, so the condition is visible without
 *     going back through boot logs nobody re-reads.
 *
 * A MISSING file stays quiet — that really is the first-run path.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cwd = process.cwd();
let dir: string;

beforeEach(() => {
  // The store captures `${cwd}/.data` at module load, so each test needs both a
  // fresh cwd and a fresh module instance.
  dir = mkdtempSync(join(tmpdir(), "woco-profile-names-load-"));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(cwd);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const STORE = (): string => join(dir, ".data", "profile-names.json");

function writeStore(contents: string): void {
  mkdirSync(join(dir, ".data"), { recursive: true });
  writeFileSync(STORE(), contents);
}

/** Everything the store quarantined, by filename. */
function quarantined(): string[] {
  try {
    return readdirSync(join(dir, ".data")).filter((f) => f.includes(".corrupt-"));
  } catch {
    return [];
  }
}

async function freshLedger() {
  const mod = await import(`../src/lib/profile/name-ledger.js?t=${Math.random()}`);
  return mod as typeof import("../src/lib/profile/name-ledger.js");
}

/** Runs `fn` with console.error captured, returning the lines it wrote. */
async function capturingErrors(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}

const ACCOUNT = "0x1111111111111111111111111111111111111111";

// ---------------------------------------------------------------------------
// A file that will not parse
// ---------------------------------------------------------------------------

test("an unreadable store is loud, quarantined, and flagged on health", async () => {
  writeStore('{ "0x11": { "label": "punkpu');

  let ledger!: Awaited<ReturnType<typeof freshLedger>>;
  const errors = await capturingErrors(async () => {
    ledger = await freshLedger();
    // Any read triggers the lazy load.
    assert.equal(ledger.profileNameOf(ACCOUNT), null, "a damaged file must not grant a name");
  });

  assert.ok(
    errors.some((l) => l.includes("[name-ledger]")),
    `the load failure was silent; lines: ${JSON.stringify(errors)}`,
  );
  assert.equal(ledger.profileNamesHealth().loadFailed, true, "health must carry the failure");

  const kept = quarantined();
  assert.equal(kept.length, 1, "the unreadable file was not preserved");
  assert.match(readFileSync(join(dir, ".data", kept[0]), "utf-8"), /punkpu/);
});

test("the next write cannot overwrite the quarantined evidence", async () => {
  // This is the whole reason the rename happens BEFORE anything else: the first
  // bind after a failed load persists the empty map, and without the rename that
  // write lands on the damaged file.
  writeStore("not json at all");
  let ledger!: Awaited<ReturnType<typeof freshLedger>>;
  await capturingErrors(async () => {
    ledger = await freshLedger();
    ledger.bindProfileName(ACCOUNT, "punkpub");
  });

  const kept = quarantined();
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(join(dir, ".data", kept[0]), "utf-8"), "not json at all");
  // …and the store itself is a fresh, valid file rather than the wreckage.
  assert.equal(ledger.profileNameOf(ACCOUNT), "punkpub");
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(STORE(), "utf-8"))), [ACCOUNT.toLowerCase()]);
});

// ---------------------------------------------------------------------------
// The two paths that must NOT alarm
// ---------------------------------------------------------------------------

test("a valid store loads, and reports no error", async () => {
  writeStore(
    JSON.stringify({
      [ACCOUNT]: {
        label: "punkpub",
        active: true,
        firstBoundAt: 1,
        lastChangedAt: 1,
        freeCorrectionUsed: false,
      },
    }),
  );
  const ledger = await freshLedger();
  assert.equal(ledger.profileNameOf(ACCOUNT), "punkpub");
  assert.equal(ledger.profileNamesHealth().loadFailed, false);
  assert.deepEqual(quarantined(), [], "a readable file must never be moved aside");
});

test("a MISSING store is silent — that is a normal first boot", async () => {
  const ledger = await freshLedger();
  const errors = await capturingErrors(async () => {
    assert.equal(ledger.profileNameOf(ACCOUNT), null);
  });
  assert.equal(ledger.profileNamesHealth().loadFailed, false);
  assert.deepEqual(errors, [], "first boot must not alarm");
  assert.deepEqual(quarantined(), []);
});
