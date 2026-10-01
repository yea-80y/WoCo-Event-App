/**
 * Passkey records (#746).
 *
 * PROVENANCE, 2026-10-01: the commitment below was produced by
 * `passkeyRecordCommit` and cross-checked against a reference Keccak-256 written
 * in Python from the Keccak specification (itself checked against the empty-input
 * digest), not against our code. The owner address goes through
 * `deriveSecpFromSeed`, which has its own pinned vectors; the sha256 of the id
 * was cross-checked with Python hashlib.
 *
 * A failure here is never a vector to update: a moved label or commitment means
 * every record already written stops matching, and every guarded sign-in on a new
 * device is refused.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  PASSKEY_BACKUP_USER_HANDLE_PREFIX,
  isBackupUserHandle,
  newBackupUserHandle,
} from "../../src/auth/passkey-backup-handle.js";
import {
  PASSKEY_RECORD_COMMIT_LABEL,
  PASSKEY_RECORD_SOC_OWNER_INFO,
  PASSKEY_RECORD_TOPIC,
  PASSKEY_RECORD_VERSION,
  parsePasskeyRecord,
  passkeyRecordCommit,
  passkeyRecordOwnerKey,
} from "../../src/auth/passkey-record.js";

const ID = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const PARENT = "0x" + "ab".repeat(20);
const PINNED = {
  idSha256: "5dfbabeedf318bf33c0927c43d7630f51b82f351740301354fa3d7fc51f0132e",
  commit: "0x2dbb18dc29e687ac142ed59b95bebef9f6fd9b6cb756c047234b03c4e083312b",
  owner: "0x0dc2be654bdfdbe9c01cf6a221ab6b7fe01a81f0",
} as const;

test("FROZEN: every passkey-record label, byte for byte", () => {
  assert.equal(PASSKEY_RECORD_TOPIC, "woco/passkey-record/v1");
  assert.equal(PASSKEY_RECORD_SOC_OWNER_INFO, "woco/passkey-record/v1/soc-owner");
  assert.equal(PASSKEY_RECORD_COMMIT_LABEL, "woco/passkey-record/v1/commit");
  assert.equal(PASSKEY_BACKUP_USER_HANDLE_PREFIX, "woco-backup-v1:");
  assert.equal(PASSKEY_RECORD_VERSION, 1);
});

test("commitment and owner pins (commitment cross-checked against a reference Keccak)", () => {
  assert.equal(createHash("sha256").update(ID).digest("hex"), PINNED.idSha256);
  assert.equal(passkeyRecordCommit(PARENT, ID), PINNED.commit);
  assert.equal(passkeyRecordCommit(PARENT.toUpperCase().replace("0X", "0x"), ID), PINNED.commit);
  assert.equal(passkeyRecordOwnerKey(ID).address, PINNED.owner);
});

test("the commitment binds both the account and the credential", () => {
  assert.notEqual(passkeyRecordCommit("0x" + "cd".repeat(20), ID), PINNED.commit);
  assert.notEqual(passkeyRecordCommit(PARENT, Uint8Array.from([...ID, 17])), PINNED.commit);
  assert.notEqual(passkeyRecordOwnerKey(Uint8Array.from([...ID, 17])).address, PINNED.owner);
  assert.throws(() => passkeyRecordCommit("0x1234", ID), /20-byte address/);
  assert.throws(() => passkeyRecordCommit(PARENT, new Uint8Array(0)), /empty credential id/);
});

test("parse accepts exactly a v1 record and nothing else", () => {
  const good = { v: 1, kind: "main", commit: PINNED.commit };
  assert.deepEqual(parsePasskeyRecord(good), good);
  for (const kind of ["added", "backup"]) assert.equal(parsePasskeyRecord({ ...good, kind })?.kind, kind);
  const bad: unknown[] = [
    null,
    [],
    "x",
    { ...good, v: 2 },
    { ...good, kind: "owner" },
    { ...good, commit: PINNED.commit.toUpperCase() },
    { ...good, commit: PINNED.commit.slice(0, -2) },
    { ...good, extra: 1 },
    { v: 1, kind: "main" },
  ];
  for (const x of bad) assert.equal(parsePasskeyRecord(x), null, JSON.stringify(x));
});

test("a backup user handle carries the frozen prefix and is recognised; others are not", () => {
  const h = newBackupUserHandle();
  assert.equal(h.length, PASSKEY_BACKUP_USER_HANDLE_PREFIX.length + 16);
  assert.ok(isBackupUserHandle(h));
  assert.notDeepEqual(newBackupUserHandle(), h, "the tail must be random");
  assert.equal(isBackupUserHandle(crypto.getRandomValues(new Uint8Array(32))), false);
  assert.equal(isBackupUserHandle(new TextEncoder().encode("woco-backup-v1")), false);
  assert.equal(isBackupUserHandle(null), false);
  assert.equal(isBackupUserHandle(new Uint8Array(0)), false);
});
