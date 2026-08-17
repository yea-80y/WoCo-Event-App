/**
 * Writing a versioned content feed from the server (`lib/swarm/content-feed-write.ts`).
 *
 * Everything pinned here fails SILENTLY in production if it breaks, which is
 * why it is worth pinning at all: a SOC is immutable, so a write at the wrong
 * identifier is discarded by bee with a 201 and the feed simply stops updating,
 * weeks before anyone notices.
 *
 *   - The next version is the head's PLUS ONE. Rewriting the head's own version
 *     is the discarded-write bug, reported as success.
 *   - An inconclusive head probe REFUSES. Treating "could not read" as "no feed
 *     here" republishes from version 0 and orphans every version before it.
 *   - Pages are uploaded BEFORE the manifest that names them, or a reader meets
 *     a manifest whose pages do not exist yet.
 *   - Page identifiers fold in the version, so a reader of version n cannot
 *     tear across n+1's pages.
 *   - The version cache is invalidated after a write, or the next write in this
 *     process recomputes the same version and is discarded.
 *
 * The bee is injected (`FeedWriteIo`) because none of these can be produced on
 * demand against a live one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey } from "@ethersphere/bee-js";
import {
  SOC_MAX_PAYLOAD_SIZE,
  contentFeedSocIdentifier,
  versionedPageIdentifier,
  versionedSocIdentifier,
  type VersionedFeedRead,
} from "@woco/shared";
import {
  confirmContentFeedWrite,
  writeVersionedContentFeed,
  type FeedWriteIo,
} from "../src/lib/swarm/content-feed-write.js";

const SIGNER = new PrivateKey(`0x${"22".repeat(32)}`);
const OWNER = SIGNER.publicKey().address().toHex().replace(/^0x/, "").toLowerCase();
const TOPIC = "woco/evidence-report/v1/test";
const BATCH = "ab".repeat(32);
const BASE = contentFeedSocIdentifier(TOPIC);

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function io(head: VersionedFeedRead) {
  const uploads: { identifier: string; payload: string }[] = [];
  const invalidated: string[] = [];
  const impl: FeedWriteIo = {
    readHead: async () => head,
    upload: async (input) => {
      uploads.push({ identifier: input.identifier, payload: input.payload });
      return undefined;
    },
    invalidate: (owner, topic) => invalidated.push(`${owner}|${topic}`),
  };
  return { impl, uploads, invalidated };
}

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

test("a feed with nothing at its head starts at version 0", async () => {
  const t = io({ status: "absent" });
  const res = await writeVersionedContentFeed(
    { signer: SIGNER, topic: TOPIC, bytes: bytes("hello"), batchId: BATCH },
    t.impl,
  );
  assert.deepEqual(res, { ok: true, version: 0, unchanged: false });
  assert.equal(t.uploads.length, 1);
  assert.equal(t.uploads[0]!.identifier, hex(versionedSocIdentifier(BASE, 0)));
});

test("an existing head is followed by the NEXT version, never overwritten", async () => {
  // The silent bug this pins: a re-upload at the head's own identifier is
  // discarded by bee — 201, old payload kept — so the feed stops updating while
  // every write reports success.
  const t = io({ status: "found", bytes: bytes("old"), version: 3 });
  const res = await writeVersionedContentFeed(
    { signer: SIGNER, topic: TOPIC, bytes: bytes("new"), batchId: BATCH },
    t.impl,
  );
  assert.deepEqual(res, { ok: true, version: 4, unchanged: false });
  assert.equal(t.uploads[0]!.identifier, hex(versionedSocIdentifier(BASE, 4)));
});

test("an inconclusive head probe refuses to write anything", async () => {
  // "Could not read" is not "nothing here". Writing version 0 on a bad read
  // would orphan every version already published.
  const t = io({ status: "unavailable", reason: "gateway 503" });
  const res = await writeVersionedContentFeed(
    { signer: SIGNER, topic: TOPIC, bytes: bytes("new"), batchId: BATCH },
    t.impl,
  );
  assert.equal(res.ok, false);
  assert.match((res as { reason: string }).reason, /inconclusive/);
  assert.equal(t.uploads.length, 0, "no postage spent on a guess");
});

test("a caller that says nothing changed gets no write", async () => {
  const t = io({ status: "found", bytes: bytes("same"), version: 7 });
  const res = await writeVersionedContentFeed(
    { signer: SIGNER, topic: TOPIC, bytes: bytes("same-ish"), batchId: BATCH, unchanged: () => true },
    t.impl,
  );
  assert.deepEqual(res, { ok: true, version: 7, unchanged: true });
  assert.equal(t.uploads.length, 0);
});

test("the unchanged predicate is asked about the CURRENT head, not the new bytes", async () => {
  const t = io({ status: "found", bytes: bytes("what-is-stored"), version: 1 });
  let sawe = "";
  await writeVersionedContentFeed(
    {
      signer: SIGNER,
      topic: TOPIC,
      bytes: bytes("what-we-would-write"),
      batchId: BATCH,
      unchanged: (head) => {
        sawe = new TextDecoder().decode(head);
        return false;
      },
    },
    t.impl,
  );
  assert.equal(sawe, "what-is-stored");
});

test("with no predicate, identical bytes are still not rewritten", async () => {
  const t = io({ status: "found", bytes: bytes("same"), version: 2 });
  const res = await writeVersionedContentFeed(
    { signer: SIGNER, topic: TOPIC, bytes: bytes("same"), batchId: BATCH },
    t.impl,
  );
  assert.equal((res as { unchanged: boolean }).unchanged, true);
  assert.equal(t.uploads.length, 0);
});

test("a payload over one chunk pages, and every page lands BEFORE the manifest naming it", async () => {
  // Order is the property, not the count: a manifest that arrives first names
  // pages a reader cannot fetch yet.
  const big = new Uint8Array(SOC_MAX_PAYLOAD_SIZE * 2 + 10).fill(65);
  const t = io({ status: "absent" });
  const res = await writeVersionedContentFeed(
    { signer: SIGNER, topic: TOPIC, bytes: big, batchId: BATCH },
    t.impl,
  );

  assert.equal((res as { version: number }).version, 0);
  assert.equal(t.uploads.length, 4, "3 pages + the manifest");
  assert.equal(t.uploads[0]!.identifier, hex(versionedPageIdentifier(BASE, 0, 1)));
  assert.equal(t.uploads[1]!.identifier, hex(versionedPageIdentifier(BASE, 0, 2)));
  assert.equal(t.uploads[2]!.identifier, hex(versionedPageIdentifier(BASE, 0, 3)));
  assert.equal(t.uploads[3]!.identifier, hex(versionedSocIdentifier(BASE, 0)), "manifest last");

  const manifest = JSON.parse(Buffer.from(t.uploads[3]!.payload, "hex").toString("utf8"));
  assert.equal(manifest._woco_mc, 1);
  assert.equal(manifest.pages, 3);
  assert.equal(manifest.len, big.length);
});

test("page identifiers are version-scoped, so no reader tears across two versions", async () => {
  const big = new Uint8Array(SOC_MAX_PAYLOAD_SIZE + 1).fill(66);
  const v0 = io({ status: "absent" });
  const v5 = io({ status: "found", bytes: bytes("old"), version: 4 });
  await writeVersionedContentFeed({ signer: SIGNER, topic: TOPIC, bytes: big, batchId: BATCH }, v0.impl);
  await writeVersionedContentFeed({ signer: SIGNER, topic: TOPIC, bytes: big, batchId: BATCH }, v5.impl);
  assert.notEqual(v0.uploads[0]!.identifier, v5.uploads[0]!.identifier);
  assert.equal(v5.uploads[0]!.identifier, hex(versionedPageIdentifier(BASE, 5, 1)));
});

test("the version cache is dropped after a write", async () => {
  // Without this the next write in this process reads the stale head, computes
  // the same version, and is silently discarded.
  const t = io({ status: "absent" });
  await writeVersionedContentFeed({ signer: SIGNER, topic: TOPIC, bytes: bytes("x"), batchId: BATCH }, t.impl);
  assert.deepEqual(t.invalidated, [`${OWNER}|${TOPIC}`]);
});

test("an empty payload is refused", async () => {
  const t = io({ status: "absent" });
  const res = await writeVersionedContentFeed(
    { signer: SIGNER, topic: TOPIC, bytes: new Uint8Array(0), batchId: BATCH },
    t.impl,
  );
  assert.equal(res.ok, false);
  assert.equal(t.uploads.length, 0);
});

// ---------------------------------------------------------------------------
// Read-back
// ---------------------------------------------------------------------------

test("read-back confirms only the exact version and the exact bytes", async () => {
  const written = bytes("published");
  const ok = await confirmContentFeedWrite(OWNER, TOPIC, written, 2, io({ status: "found", bytes: written, version: 2 }).impl);
  assert.deepEqual(ok, { ok: true });

  // A dead batch's shape: the upload said 201 and nothing is there.
  const absent = await confirmContentFeedWrite(OWNER, TOPIC, written, 2, io({ status: "absent" }).impl);
  assert.equal(absent.ok, false);

  // The predecessor is still at the head — our write went nowhere.
  const older = await confirmContentFeedWrite(OWNER, TOPIC, written, 2, io({ status: "found", bytes: written, version: 1 }).impl);
  assert.equal(older.ok, false);
  assert.match((older as { reason: string }).reason, /version/);

  // Right version, different content: something else won this version.
  const different = await confirmContentFeedWrite(
    OWNER,
    TOPIC,
    written,
    2,
    io({ status: "found", bytes: bytes("something else"), version: 2 }).impl,
  );
  assert.equal(different.ok, false);
  assert.match((different as { reason: string }).reason, /bytes differ/);
});
