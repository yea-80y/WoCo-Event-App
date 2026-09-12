/**
 * Manifest repair path (#190).
 *
 * The manifest is a read-modify-write over a SEALED whole object, so every mutator
 * refuses when it cannot read the latest version — which is right, and which left
 * a user whose latest version can NEVER read with nothing at all: no backup list,
 * no keep-list edits, and a "check your connection" message about a permanent
 * fault. These two primitives are the way out, and the contract they must hold is
 * narrow in both directions:
 *
 *  - DIAGNOSE may only conclude "frozen" from a version-named verdict, and may
 *    only WALK in that case. Walking a transient fault would hand the UI a "last
 *    readable copy" to offer as a repair over a manifest that is probably intact —
 *    #171 again, entered through the door built to fix it.
 *  - REBUILD is the destructive half, so it re-reads FIRST and refuses unless the
 *    freeze is still there. The user's click is separated from the diagnosis by
 *    however long they spent reading the warning.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { USER_MANIFEST_TOPIC, USER_MANIFEST_VERSION, type UserManifest } from "@woco/shared";
import {
  diagnoseManifest,
  rebuildManifest,
  readUserManifestResult,
  MANIFEST_REPAIR_WALK_LIMIT,
  type ManifestReadResult,
  type ManifestSigner,
} from "../src/lib/manifest/inventory.js";
import { sealToSelf } from "../src/lib/manifest/self-seal.js";
import type { ContentFeedResult } from "../src/lib/swarm/content-feed.js";

const SIGNER: ManifestSigner = { privKey: "0x" + "22".repeat(32), address: "0x" + "33".repeat(20) };
const PARENT = "0x" + "44".repeat(20);

const manifestAt = (updatedAt: number, extra: Partial<UserManifest> = {}): UserManifest => ({
  v: USER_MANIFEST_VERSION,
  updatedAt,
  backups: [],
  ...extra,
});

/** A real sealed envelope for this signer+parent, so the walk's open path is exercised. */
const sealed = (m: UserManifest) =>
  sealToSelf({ feedSignerPrivKey: SIGNER.privKey, parentAddress: PARENT, data: m });

const readingAs = (r: ManifestReadResult) => async () => r;

/** Exact-version reader over a fixed map of version → payload. */
function readerOver(versions: Record<number, unknown>) {
  const seen: number[] = [];
  const readAt = async (
    owner: string,
    topic: string,
    version: number,
  ): Promise<ContentFeedResult<unknown>> => {
    assert.equal(owner, SIGNER.address);
    assert.equal(topic, USER_MANIFEST_TOPIC);
    seen.push(version);
    const value = versions[version];
    if (value === undefined) return { status: "unavailable", reason: "test: unreadable" };
    return { status: "found", value, version, scanClean: true };
  };
  return { readAt, seen };
}

test("frozen at 5 with 4 unreadable and 3 readable seeds from 3, having walked 2", async () => {
  const good = manifestAt(1_700_000_000_000, { backups: [] });
  const r = readerOver({ 3: sealed(good) });

  const d = await diagnoseManifest({
    signer: SIGNER,
    parentAddress: PARENT,
    readManifest: readingAs({ status: "unavailable", reason: "won't open", unusableAt: 5 }),
    readAt: r.readAt,
  });

  assert.equal(d.kind, "frozen");
  assert.equal(d.kind === "frozen" && d.unusableAt, 5);
  assert.equal(d.kind === "frozen" && d.seed?.version, 3);
  assert.equal(d.kind === "frozen" && d.seed?.manifest.updatedAt, good.updatedAt);
  assert.equal(d.kind === "frozen" && d.walked, 2);
  assert.deepEqual(r.seen, [4, 3]); // newest first, and it STOPS at the first that opens
});

test("frozen at 0 walks nothing — there is no earlier version to walk to", async () => {
  const r = readerOver({});
  const d = await diagnoseManifest({
    signer: SIGNER,
    parentAddress: PARENT,
    readManifest: readingAs({ status: "unavailable", reason: "not an envelope", unusableAt: 0 }),
    readAt: r.readAt,
  });

  assert.equal(d.kind === "frozen" && d.seed, null);
  assert.equal(d.kind === "frozen" && d.walked, 0);
  assert.deepEqual(r.seen, []);
});

test("a TRANSIENT failure is transient, and reads NOTHING — no seed may exist to offer", async () => {
  const r = readerOver({ 4: sealed(manifestAt(1)), 3: sealed(manifestAt(2)) });
  const d = await diagnoseManifest({
    signer: SIGNER,
    parentAddress: PARENT,
    readManifest: readingAs({ status: "unavailable", reason: "gateway 502" }),
    readAt: r.readAt,
  });

  assert.equal(d.kind, "transient");
  assert.equal(d.kind === "transient" && d.reason, "gateway 502");
  assert.deepEqual(r.seen, [], "the walk must not run on a fault that may clear");
});

test("a readable manifest is ok, an absent one is absent", async () => {
  const ok = await diagnoseManifest({
    signer: SIGNER,
    parentAddress: PARENT,
    readManifest: readingAs({ status: "found", manifest: manifestAt(1) }),
  });
  assert.deepEqual(ok, { kind: "ok" });

  const gone = await diagnoseManifest({
    signer: SIGNER,
    parentAddress: PARENT,
    readManifest: readingAs({ status: "absent" }),
  });
  assert.deepEqual(gone, { kind: "absent" });
});

test("the walk stops at MANIFEST_REPAIR_WALK_LIMIT", async () => {
  const r = readerOver({}); // nothing opens, so the walk runs to its floor
  const unusableAt = 100;
  const d = await diagnoseManifest({
    signer: SIGNER,
    parentAddress: PARENT,
    readManifest: readingAs({ status: "unavailable", unusableAt }),
    readAt: r.readAt,
  });

  assert.equal(d.kind === "frozen" && d.seed, null);
  assert.equal(d.kind === "frozen" && d.walked, MANIFEST_REPAIR_WALK_LIMIT);
  assert.equal(r.seen.length, MANIFEST_REPAIR_WALK_LIMIT);
  assert.equal(r.seen[0], unusableAt - 1);
  assert.equal(r.seen[r.seen.length - 1], unusableAt - MANIFEST_REPAIR_WALK_LIMIT);
});

test("a walked version that is not a USABLE manifest is skipped, not seeded from", async () => {
  // Version 4 opens to junk (no backups array); 3 is a real manifest. The walk must
  // apply the same bar as the head read, or a repair could seed from garbage.
  const r = readerOver({
    4: sealed({ hello: "world" } as unknown as UserManifest),
    3: sealed(manifestAt(1_700_000_000_777)),
  });
  const d = await diagnoseManifest({
    signer: SIGNER,
    parentAddress: PARENT,
    readManifest: readingAs({ status: "unavailable", unusableAt: 5 }),
    readAt: r.readAt,
  });

  assert.equal(d.kind === "frozen" && d.seed?.version, 3);
  assert.equal(d.kind === "frozen" && d.walked, 2);
});

test("rebuild REFUSES when the re-read says the manifest is readable again", async () => {
  let wrote = false;
  await assert.rejects(
    rebuildManifest({
      signer: SIGNER,
      parentAddress: PARENT,
      seed: manifestAt(1),
      readManifest: readingAs({ status: "found", manifest: manifestAt(2) }),
      write: async () => { wrote = true; return 9; },
    }),
    /reads fine now/,
  );
  assert.equal(wrote, false, "a readable manifest must never be overwritten");
});

test("rebuild REFUSES on an unavailable-but-not-frozen re-read", async () => {
  let wrote = false;
  await assert.rejects(
    rebuildManifest({
      signer: SIGNER,
      parentAddress: PARENT,
      seed: null,
      readManifest: readingAs({ status: "unavailable", reason: "gateway 502" }),
      write: async () => { wrote = true; return 9; },
    }),
    /Couldn't confirm/,
  );
  assert.equal(wrote, false, "an offline manifest must never be overwritten");
});

test("rebuild writes the seed forward: v pinned, updatedAt fresh, sections carried", async () => {
  const seed: UserManifest = manifestAt(1_600_000_000_000, {
    backups: [{ guardianAddress: "0x" + "55".repeat(20), method: "wallet", addedAt: 5 }],
    feeds: [{ kind: "profile", topic: "woco/profile/data/0xabc", updatedAt: 7 }],
    trash: [{ kind: "site", topic: "woco/site/config/x", deletedAt: 8 }],
  } as Partial<UserManifest>);

  let written: UserManifest | null = null;
  const before = Date.now();
  const version = await rebuildManifest({
    signer: SIGNER,
    parentAddress: PARENT,
    seed,
    readManifest: readingAs({ status: "unavailable", reason: "won't open", unusableAt: 5 }),
    write: async (a) => { written = a.manifest; return 6; },
  });

  assert.equal(version, 6);
  const w = written as unknown as UserManifest;
  assert.equal(w.v, USER_MANIFEST_VERSION);
  assert.ok(w.updatedAt >= before, "updatedAt must be the repair time, not the seed's");
  assert.deepEqual(w.backups, seed.backups);
  assert.deepEqual(w.feeds, seed.feeds);
  assert.deepEqual(w.trash, seed.trash);
});

test("rebuild with no seed writes an empty list, not undefined backups", async () => {
  let written: UserManifest | null = null;
  await rebuildManifest({
    signer: SIGNER,
    parentAddress: PARENT,
    seed: null,
    readManifest: readingAs({ status: "unavailable", unusableAt: 0 }),
    write: async (a) => { written = a.manifest; return 1; },
  });
  const w = written as unknown as UserManifest;
  assert.deepEqual(w.backups, []);
  assert.equal(w.v, USER_MANIFEST_VERSION);
});

// ── newerFormat: a later envelope is not damage ──────────────────────────────

test("a v2 envelope reads as newerFormat (reload), a v1 one does not", async () => {
  const newer = { v: 2, nonce: "00".repeat(24), ct: "ab" };
  const read = await readUserManifestResult({
    signer: SIGNER,
    parentAddress: PARENT,
    // Injected at the FEED layer: this is the real narrowing path, envelope and all.
    readFeed: async (): Promise<ContentFeedResult<unknown>> =>
      ({ status: "found", value: newer, version: 4, scanClean: true }),
  });
  assert.equal(read.status, "unavailable");
  assert.equal(read.status === "unavailable" && read.unusableAt, 4);
  assert.equal(read.status === "unavailable" && read.newerFormat, true);

  // A v1 envelope this signer cannot open is DAMAGE, not a newer format: it must
  // offer repair, so newerFormat must stay false.
  const v1 = { v: 1, nonce: "00".repeat(24), ct: "ab" };
  const damaged = await readUserManifestResult({
    signer: SIGNER,
    parentAddress: PARENT,
    readFeed: async (): Promise<ContentFeedResult<unknown>> =>
      ({ status: "found", value: v1, version: 4, scanClean: true }),
  });
  assert.equal(damaged.status === "unavailable" && damaged.unusableAt, 4);
  assert.notEqual(damaged.status === "unavailable" && damaged.newerFormat, true);
});

test("a won't-open envelope NAMES its version — without it the freeze is invisible", async () => {
  const wrongKey = sealToSelf({
    feedSignerPrivKey: "0x" + "77".repeat(32), // sealed to a different key
    parentAddress: PARENT,
    data: manifestAt(1),
  });
  const read = await readUserManifestResult({
    signer: SIGNER,
    parentAddress: PARENT,
    readFeed: async (): Promise<ContentFeedResult<unknown>> =>
      ({ status: "found", value: wrongKey, version: 11, scanClean: true }),
  });
  assert.equal(read.status, "unavailable");
  assert.equal(read.status === "unavailable" && read.unusableAt, 11);

  // And the diagnosis built on it must be FROZEN, not transient — this is the
  // whole chain the issue is about, in one assertion.
  const d = await diagnoseManifest({
    signer: SIGNER,
    parentAddress: PARENT,
    readManifest: async () => read,
    readAt: readerOver({}).readAt,
  });
  assert.equal(d.kind, "frozen");
});

test("a transient FEED read stays transient all the way through", async () => {
  const read = await readUserManifestResult({
    signer: SIGNER,
    parentAddress: PARENT,
    readFeed: async (): Promise<ContentFeedResult<unknown>> =>
      ({ status: "unavailable", reason: "version probe inconclusive" }),
  });
  assert.equal(read.status === "unavailable" && read.unusableAt, undefined);
});
