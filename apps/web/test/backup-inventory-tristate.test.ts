/**
 * Tri-state backup-inventory read (#166 item 4).
 *
 * The contract under test: only a manifest that was READ (or provably does not
 * exist) may answer "these are the backups" — a read that couldn't tell must
 * come back `unavailable`, because every consumer is a security surface (the
 * add-a-backup nudge, the studio safety panel, and the "adding a backup
 * resurrects the ones you removed" warning) and each of them used to act on a
 * collapsed empty array.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { BackupInventoryEntry } from "@woco/shared";
import { readBackupHistoryResult } from "../src/lib/manifest/backup-inventory.js";
import type { ManifestReadResult } from "../src/lib/manifest/inventory.js";

const SIGNER = { privKey: "0x" + "22".repeat(32), address: "0x" + "33".repeat(20) };
const PARENT = "0x" + "44".repeat(20);

const ENTRY: BackupInventoryEntry = {
  guardianAddress: "0x" + "55".repeat(20),
  method: "wallet",
  addedAt: 1_700_000_000_000,
} as BackupInventoryEntry;

function readingAs(result: ManifestReadResult) {
  return async () => result;
}

test("a found manifest answers with its backups, retired rows included", async () => {
  const read = await readBackupHistoryResult({
    signer: SIGNER,
    parentAddress: PARENT,
    readManifest: readingAs({
      status: "found",
      manifest: { v: 1, updatedAt: 1, backups: [ENTRY, { ...ENTRY, revoked: true }] },
    }),
  });
  assert.equal(read.status, "known");
  assert.equal(read.status === "known" && read.backups.length, 2);
});

test("a definitively absent manifest is a KNOWN empty inventory — the one empty that may nudge", async () => {
  const read = await readBackupHistoryResult({
    signer: SIGNER,
    parentAddress: PARENT,
    readManifest: readingAs({ status: "absent" }),
  });
  assert.deepEqual(read, { status: "known", backups: [] });
});

test("an unreadable manifest is UNAVAILABLE — never an empty inventory", async () => {
  const read = await readBackupHistoryResult({
    signer: SIGNER,
    parentAddress: PARENT,
    readManifest: readingAs({ status: "unavailable", reason: "gateway 502" }),
  });
  assert.equal(read.status, "unavailable");
  assert.equal(read.status === "unavailable" && read.reason, "gateway 502");
});
