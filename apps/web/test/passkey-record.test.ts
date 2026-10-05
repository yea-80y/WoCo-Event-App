/**
 * The passkey-record guard and its creation-time write (#746).
 *
 * Two rules, chosen by how the passkey answered:
 * - on this device (or the browser did not say): a record can only ever REFUSE. No
 *   record, an unreadable one, or a format this build does not know must all let the
 *   sign-in proceed exactly as before - a gateway outage must never lock anyone out;
 * - from another device (a phone by QR code, or a security key): only a confirmed
 *   record, or this device's own pending record for the same pair, lets it commit.
 *
 * MUTATIONS these catch: strict on "platform" or null; absent / unknown format / an
 * unreadable read proceeding from another device; unreadable shown as the steer; a
 * throwing read treated as absent; a backup steered instead of refused; the pending
 * slot ignoring its credential or account, comparing case-sensitively, or overriding
 * a record that names another account; thorough dropped, or used on the lenient rule.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { passkeyRecordCommit, type PasskeyRecord } from "@woco/shared/auth/passkey-record";
import type { ContentFeedResult } from "../src/lib/swarm/content-feed.ts";

const {
  classifyPasskeyRecord,
  credentialIdBytes,
  ensurePasskeyRecord,
  guardPasskeyRecord,
  passkeyRecordVerdict,
  pendingRecordMatches,
  signInRecordOutcome,
  PasskeyRecordMismatchError,
  PasskeyRecordUnreadableError,
} = await import("../src/lib/auth/passkey-record.ts");
const { PasskeyIsBackupError, PasskeyFromAnotherDeviceError } = await import("../src/lib/auth/passkey-account.ts");

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

test("guard on this device: throws the refusal the login modal shows, and nothing otherwise", async () => {
  const read = (r: ContentFeedResult<unknown>) => ({ read: async () => r });
  for (const attachment of ["platform", null] as const) {
    await guardPasskeyRecord(CRED, PARENT, attachment, read(found(record(PARENT))));
    await guardPasskeyRecord(CRED, PARENT, attachment, read({ status: "absent" }));
    await guardPasskeyRecord(CRED, PARENT, attachment, read({ status: "unavailable" }));
    await guardPasskeyRecord(CRED, PARENT, attachment, read(found({ ...record(OTHER), v: 2 })));
    await assert.rejects(
      guardPasskeyRecord(CRED, OTHER, attachment, read(found(record(PARENT)))),
      PasskeyRecordMismatchError,
    );
    await assert.rejects(
      guardPasskeyRecord(CRED, PARENT, attachment, read(found(record(PARENT, "backup")))),
      PasskeyIsBackupError,
    );
  }
});

test("a read that THROWS on this device proceeds - it is unreadable, not a refusal", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    await guardPasskeyRecord(CRED, OTHER, "platform", {
      read: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
  } finally {
    console.warn = warn;
  }
});

test("classify: every read outcome has its own reading", () => {
  assert.equal(classifyPasskeyRecord(found(record(PARENT)), ID, PARENT), "match");
  assert.equal(classifyPasskeyRecord(found(record(PARENT, "added")), ID, PARENT), "match");
  assert.equal(classifyPasskeyRecord(found(record(PARENT)), ID, OTHER), "mismatch");
  assert.equal(classifyPasskeyRecord(found(record(PARENT, "backup")), ID, PARENT), "backup");
  assert.equal(classifyPasskeyRecord({ status: "absent" }, ID, PARENT), "absent");
  assert.equal(classifyPasskeyRecord({ status: "unavailable" }, ID, PARENT), "unreadable");
  assert.equal(classifyPasskeyRecord(found({ ...record(PARENT), v: 2 }), ID, PARENT), "unknown-format");
  assert.equal(classifyPasskeyRecord(found("not json object"), ID, PARENT), "unknown-format");
});

test("outcome matrix: from another device only a match - or this device's own pending record - commits", () => {
  const readings = ["match", "mismatch", "backup", "absent", "unreadable", "unknown-format"] as const;
  const expected = {
    lenient: { match: "proceed", mismatch: "mismatch", backup: "backup", absent: "proceed", unreadable: "proceed", "unknown-format": "proceed" },
    strict: { match: "proceed", mismatch: "other-device", backup: "backup", absent: "other-device", unreadable: "unreadable", "unknown-format": "other-device" },
    strictPending: { match: "proceed", mismatch: "other-device", backup: "backup", absent: "proceed", unreadable: "proceed", "unknown-format": "proceed" },
  } as const;
  for (const r of readings) {
    for (const attachment of ["platform", null] as const) {
      // The pending slot changes nothing on this device: it already proceeds.
      assert.equal(signInRecordOutcome(r, attachment, false), expected.lenient[r], `${attachment}/${r}`);
      assert.equal(signInRecordOutcome(r, attachment, true), expected.lenient[r], `${attachment}/${r}/pending`);
    }
    assert.equal(signInRecordOutcome(r, "cross-platform", false), expected.strict[r], `cross-platform/${r}`);
    assert.equal(signInRecordOutcome(r, "cross-platform", true), expected.strictPending[r], `cross-platform/${r}/pending`);
  }
});

test("pending slot: matches only the exact credential and account, account case-insensitive", () => {
  const OTHER_CRED = "AgMEBQYHCAkKCwwNDg8QEQ";
  assert.equal(pendingRecordMatches({ credentialId: CRED, parent: PARENT }, CRED, PARENT), true);
  assert.equal(pendingRecordMatches({ credentialId: CRED, parent: PARENT.toUpperCase().replace("0X", "0x") }, CRED, PARENT), true);
  assert.equal(pendingRecordMatches({ credentialId: CRED, parent: PARENT }, CRED, PARENT.toUpperCase().replace("0X", "0x")), true);
  assert.equal(pendingRecordMatches({ credentialId: CRED, parent: OTHER }, CRED, PARENT), false);
  assert.equal(pendingRecordMatches({ credentialId: OTHER_CRED, parent: PARENT }, CRED, PARENT), false);
  assert.equal(pendingRecordMatches(null, CRED, PARENT), false);
  assert.equal(pendingRecordMatches(undefined, CRED, PARENT), false);
});

test("guard from another device: commits only on a confirmed record, with the matching refusal otherwise", async () => {
  const read = (r: ContentFeedResult<unknown>) => async () => r;
  const x = "cross-platform" as const;
  await guardPasskeyRecord(CRED, PARENT, x, { read: read(found(record(PARENT))) });
  await guardPasskeyRecord(CRED, PARENT, x, { read: read(found(record(PARENT, "added"))) });
  await assert.rejects(guardPasskeyRecord(CRED, PARENT, x, { read: read({ status: "absent" }) }), PasskeyFromAnotherDeviceError);
  await assert.rejects(guardPasskeyRecord(CRED, OTHER, x, { read: read(found(record(PARENT))) }), PasskeyFromAnotherDeviceError);
  await assert.rejects(
    guardPasskeyRecord(CRED, PARENT, x, { read: read(found({ ...record(PARENT), v: 2 })) }),
    PasskeyFromAnotherDeviceError,
    "a future record format refuses an older build - it cannot confirm it",
  );
  await assert.rejects(guardPasskeyRecord(CRED, PARENT, x, { read: read({ status: "unavailable" }) }), PasskeyRecordUnreadableError);
  await assert.rejects(
    guardPasskeyRecord(CRED, PARENT, x, { read: read(found(record(PARENT, "backup"))) }),
    PasskeyIsBackupError,
  );
});

test("guard from another device: a throwing read is unreadable (retry), never absent (steer) and never a pass", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(
      guardPasskeyRecord(CRED, PARENT, "cross-platform", {
        read: async () => {
          throw new TypeError("Failed to fetch");
        },
      }),
      PasskeyRecordUnreadableError,
    );
  } finally {
    console.warn = warn;
  }
});

test("guard from another device: this device's own pending record stands in for one not yet written", async () => {
  const absent = { read: async (): Promise<ContentFeedResult<unknown>> => ({ status: "absent" }) };
  const unreadable = { read: async (): Promise<ContentFeedResult<unknown>> => ({ status: "unavailable" }) };
  const mismatch = { read: async (): Promise<ContentFeedResult<unknown>> => found(record(OTHER)) };
  const mine = { credentialId: CRED, parent: PARENT };
  await guardPasskeyRecord(CRED, PARENT, "cross-platform", { ...absent, pending: mine });
  await guardPasskeyRecord(CRED, PARENT, "cross-platform", { ...unreadable, pending: mine });
  await assert.rejects(
    guardPasskeyRecord(CRED, OTHER, "cross-platform", { ...absent, pending: mine }),
    PasskeyFromAnotherDeviceError,
    "the slot confirms only the account this device created",
  );
  await assert.rejects(
    guardPasskeyRecord(CRED, PARENT, "cross-platform", { ...mismatch, pending: mine }),
    PasskeyFromAnotherDeviceError,
    "a record naming another account wins over the slot",
  );
});

test("the read is thorough exactly when an absent would refuse", async () => {
  const seen: (boolean | undefined)[] = [];
  const read = async (_id: Uint8Array, opts?: { thorough?: boolean }): Promise<ContentFeedResult<unknown>> => {
    seen.push(opts?.thorough);
    return found(record(PARENT));
  };
  await guardPasskeyRecord(CRED, PARENT, "cross-platform", { read });
  await guardPasskeyRecord(CRED, PARENT, "platform", { read });
  await guardPasskeyRecord(CRED, PARENT, null, { read });
  assert.deepEqual(seen, [true, undefined, undefined]);
});

test("every refusal reads as plain words: no PRF, biometric, hex address or em dash", () => {
  for (const msg of [
    new PasskeyRecordMismatchError().message,
    new PasskeyRecordUnreadableError().message,
    new PasskeyFromAnotherDeviceError().message,
  ]) {
    assert.doesNotMatch(msg, /PRF|biometric|0x|\u2014/i);
  }
  assert.equal(
    new PasskeyFromAnotherDeviceError().message,
    "That sign-in came from your phone - add this computer from your phone instead.",
  );
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
