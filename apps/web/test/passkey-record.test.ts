/**
 * The passkey-record guard and its creation-time write (#746).
 *
 * The property that matters most is the asymmetry: a record can only ever REFUSE.
 * No record, an unreadable one, or a format this build does not know must all let
 * the sign-in proceed exactly as before - a gateway outage must never lock anyone
 * out.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { passkeyRecordCommit, type PasskeyRecord } from "@woco/shared/auth/passkey-record";
import type { ContentFeedResult } from "../src/lib/swarm/content-feed.ts";

const {
  credentialIdBytes,
  ensurePasskeyRecord,
  guardPasskeyRecord,
  passkeyRecordVerdict,
  PasskeyRecordMismatchError,
} = await import("../src/lib/auth/passkey-record.ts");
const { PasskeyIsBackupError } = await import("../src/lib/auth/passkey-account.ts");

const CRED = "AQIDBAUGBwgJCgsMDQ4PEA"; // bytes 1..16
const ID = credentialIdBytes(CRED);
const PARENT = "0x" + "ab".repeat(20);
const OTHER = "0x" + "cd".repeat(20);
const found = (value: unknown): ContentFeedResult<unknown> => ({ status: "found", value, version: 0, scanClean: true });
const record = (parent: string, kind: PasskeyRecord["kind"] = "main"): PasskeyRecord => ({
  v: 1,
  kind,
  commit: passkeyRecordCommit(parent, ID),
});

test("credential ids decode from base64url", () => {
  assert.deepEqual([...ID], Array.from({ length: 16 }, (_, i) => i + 1));
});

test("verdict: only a record naming another account, or a backup, refuses", () => {
  assert.equal(passkeyRecordVerdict(found(record(PARENT)), ID, PARENT), "proceed");
  assert.equal(passkeyRecordVerdict(found(record(PARENT)), ID, PARENT.toUpperCase().replace("0X", "0x")), "proceed");
  assert.equal(passkeyRecordVerdict(found(record(PARENT)), ID, OTHER), "mismatch");
  assert.equal(passkeyRecordVerdict(found(record(PARENT, "backup")), ID, PARENT), "backup");
});

test("verdict: absent, unreadable or an unknown format all proceed - nothing locks anyone out", () => {
  assert.equal(passkeyRecordVerdict({ status: "absent" }, ID, PARENT), "proceed");
  assert.equal(passkeyRecordVerdict({ status: "unavailable", reason: "gateway down" }, ID, PARENT), "proceed");
  assert.equal(passkeyRecordVerdict(found({ ...record(OTHER), v: 2 }), ID, PARENT), "proceed");
  assert.equal(passkeyRecordVerdict(found("not json object"), ID, PARENT), "proceed");
});

test("guard throws the refusal the login modal shows, and nothing otherwise", async () => {
  const read = (r: ContentFeedResult<unknown>) => ({ read: async () => r });
  await guardPasskeyRecord(CRED, PARENT, read(found(record(PARENT))));
  await guardPasskeyRecord(CRED, PARENT, read({ status: "absent" }));
  await guardPasskeyRecord(CRED, PARENT, read({ status: "unavailable" }));
  await assert.rejects(guardPasskeyRecord(CRED, OTHER, read(found(record(PARENT)))), PasskeyRecordMismatchError);
  await assert.rejects(guardPasskeyRecord(CRED, PARENT, read(found(record(PARENT, "backup")))), PasskeyIsBackupError);
  // The copy is what a person reads - never "PRF", never a hex address.
  const msg = new PasskeyRecordMismatchError().message;
  assert.doesNotMatch(msg, /PRF|0x/);
});

test("a read that THROWS (a client-side network exception) proceeds - it is unreadable, not a refusal", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    await guardPasskeyRecord(CRED, OTHER, {
      read: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
  } finally {
    console.warn = warn;
  }
});

test("ensure: writes version 0 once; leaves an existing record; retries when unreadable", async () => {
  const writes: PasskeyRecord[] = [];
  const deps = (r: ContentFeedResult<unknown>) => ({
    read: async () => r,
    write: async (_id: Uint8Array, rec: PasskeyRecord) => {
      writes.push(rec);
    },
  });

  assert.equal(await ensurePasskeyRecord({ credentialId: CRED, parent: PARENT }, deps({ status: "absent" })), "written");
  assert.deepEqual(writes, [record(PARENT)]);

  assert.equal(
    await ensurePasskeyRecord({ credentialId: CRED, parent: PARENT }, deps(found(record(PARENT)))),
    "present",
  );
  assert.equal(
    await ensurePasskeyRecord({ credentialId: CRED, parent: PARENT }, deps(found(record(OTHER)))),
    "conflict",
    "never overwrite a record that names another account",
  );
  assert.equal(
    await ensurePasskeyRecord({ credentialId: CRED, parent: PARENT }, deps({ status: "unavailable" })),
    "unavailable",
  );
  assert.equal(writes.length, 1, "only the absent case may write");
});
