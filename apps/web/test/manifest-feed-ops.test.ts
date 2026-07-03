/**
 * Semantics locks for the manifest feed log + trash (pure ops — Phase 4).
 * These are the properties batch migration and deletion-by-omission depend on:
 *   1. Upsert is idempotent per (kind, topic) — no duplicate keep-list entries.
 *   2. A replaced immutable ref (old avatar image, superseded site build) is
 *      DISPLACED into trash, never silently dropped — the restore window and
 *      the "garbage" audit trail both hang off this.
 *   3. Whole-feed delete → trash keeps the topic and restores losslessly.
 *   4. Other manifest sections (backups, unknown future fields) survive every op.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { UserManifest, ManifestFeedEntry } from "@woco/shared";
import { mergeFeedEntry, removeFeedEntry, restoreFeedEntry } from "../src/lib/manifest/ops.js";

const entry = (over: Partial<ManifestFeedEntry> = {}): ManifestFeedEntry => ({
  kind: "avatar",
  topic: "woco/profile/avatar/0xabc",
  refs: ["aa".repeat(32)],
  updatedAt: 1,
  ...over,
});

test("upsert into empty manifest creates the feeds section", () => {
  const m = mergeFeedEntry(null, entry());
  assert.equal(m.feeds?.length, 1);
  assert.equal(m.backups.length, 0);
  assert.equal(m.trash, undefined);
});

test("upsert dedups by kind+topic and displaces dropped refs to trash", () => {
  const oldRef = "aa".repeat(32);
  const newRef = "bb".repeat(32);
  const m1 = mergeFeedEntry(null, entry({ refs: [oldRef] }));
  const m2 = mergeFeedEntry(m1, entry({ refs: [newRef], updatedAt: 2 }));

  assert.equal(m2.feeds?.length, 1);
  assert.deepEqual(m2.feeds![0]!.refs, [newRef]);
  assert.equal(m2.trash?.length, 1);
  assert.deepEqual(m2.trash![0]!.refs, [oldRef]);
  assert.equal(m2.trash![0]!.topic, undefined); // displacement, not deletion
});

test("kept refs are not displaced", () => {
  const keep = "cc".repeat(32);
  const m1 = mergeFeedEntry(null, entry({ refs: [keep] }));
  const m2 = mergeFeedEntry(m1, entry({ refs: [keep], updatedAt: 2 }));
  assert.equal(m2.trash, undefined);
});

test("superseded site contentHash is displaced to trash", () => {
  const site = (hash: string): ManifestFeedEntry => ({
    kind: "site",
    topic: "woco/site/config/01JXSITE",
    label: "The Crown",
    siteMeta: { contentHash: hash, feedManifestHash: "fe".repeat(32) },
    updatedAt: 1,
  });
  const m1 = mergeFeedEntry(null, site("11".repeat(32)));
  const m2 = mergeFeedEntry(m1, site("22".repeat(32)));
  assert.equal(m2.feeds?.length, 1);
  assert.deepEqual(m2.trash?.[0]?.refs, ["11".repeat(32)]);
});

test("remove → trash (topic kept) → restore round-trips", () => {
  const e = entry({ kind: "event", topic: "woco/event/ev1", label: "Launch", refs: undefined });
  const m1 = mergeFeedEntry(null, e);
  const m2 = removeFeedEntry(m1, "event", "woco/event/ev1");
  assert.equal(m2.feeds?.length, 0);
  assert.equal(m2.trash?.length, 1);
  assert.equal(m2.trash![0]!.topic, "woco/event/ev1");
  assert.equal(m2.trash![0]!.label, "Launch");

  const m3 = restoreFeedEntry(m2, "event", "woco/event/ev1");
  assert.equal(m3.trash?.length ?? 0, 0);
  assert.equal(m3.feeds?.length, 1);
  assert.equal(m3.feeds![0]!.topic, "woco/event/ev1");
  assert.equal(m3.feeds![0]!.label, "Launch");
});

test("remove of a missing entry is a no-op; restore ignores ref-only trash", () => {
  const m1 = removeFeedEntry(null, "site", "woco/site/config/nope");
  assert.equal(m1.feeds?.length ?? 0, 0);
  assert.equal(m1.trash?.length ?? 0, 0);

  const withDisplaced = mergeFeedEntry(mergeFeedEntry(null, entry()), entry({ refs: ["dd".repeat(32)], updatedAt: 2 }));
  const restored = restoreFeedEntry(withDisplaced, "avatar", "woco/profile/avatar/0xabc");
  // The displaced-ref trash entry has no topic → nothing to restore.
  assert.equal(restored.trash?.length, 1);
});

test("backups and unknown future sections survive every op", () => {
  const existing = {
    v: 1,
    updatedAt: 1,
    backups: [{ method: "email", guardianAddress: "0x" + "11".repeat(20), addedAt: 1 }],
    futureSection: { keep: true },
  } as unknown as UserManifest;

  const afterMerge = mergeFeedEntry(existing, entry());
  const afterRemove = removeFeedEntry(afterMerge, "avatar", entry().topic);
  const afterRestore = restoreFeedEntry(afterRemove, "avatar", entry().topic);

  for (const m of [afterMerge, afterRemove, afterRestore]) {
    assert.equal(m.backups.length, 1);
    assert.deepEqual((m as unknown as { futureSection: unknown }).futureSection, { keep: true });
  }
});

test("trash is capped (oldest dropped)", () => {
  let m: UserManifest | null = null;
  for (let i = 0; i < 210; i++) {
    m = mergeFeedEntry(m, entry({ refs: [i.toString(16).padStart(2, "0").repeat(32).slice(0, 64)], updatedAt: i }));
  }
  assert.ok((m!.trash?.length ?? 0) <= 200);
});
