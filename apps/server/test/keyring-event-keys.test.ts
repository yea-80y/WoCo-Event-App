/**
 * Events read and sold under the organiser's CURRENT keys (#186): once the account
 * has a key ring, the feed signer and order key are the ring's, whatever the record
 * pinned at create or the feed itself says.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventFeed } from "@woco/shared";
import type { KeyRing } from "@woco/shared/keyring/ring";

const originalCwd = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "woco-event-keys-"));
process.chdir(dir);
process.env.BEE_URL = "http://127.0.0.1:1";
process.env.EMAIL_HASH_SECRET ??= "0".repeat(64);
process.env.FEED_PRIVATE_KEY ??= "11".repeat(32);
const record = await import("../src/lib/event/feed-signer-record.js");
const ringRead = await import("../src/lib/keyring/current-ring.js");
const keysMod = await import("../src/lib/keyring/event-keys.js");
const service = await import("../src/lib/event/service.js");
process.chdir(originalCwd);
after(() => rmSync(dir, { recursive: true, force: true }));

const EVENT = "e0000000-0000-4000-8000-0000000000e1";
const CREATOR = "0x" + "aa".repeat(20);
const F0 = "0x" + "f0".repeat(20);
const F1 = "0x" + "f1".repeat(20);
const K0 = "0a".repeat(32);
const K1 = "1b".repeat(32);

let ringOf: Map<string, Partial<KeyRing> | "down">;

function stubRings() {
  // Ring reads stubbed at the module seam: the anchor returns a fake ref per account,
  // and the ring "bytes" are never fetched because the parsed ring is served from here.
  ringRead._setCurrentRingDepsForTests({
    readAnchor: async (a) => {
      const r = ringOf.get(a);
      if (r === "down") throw new Error("rpc down");
      return r ? `0x${"cc".repeat(32)}` : `0x${"0".repeat(64)}`;
    },
    fetchChunk: async () => {
      throw new Error("not used");
    },
  });
}

function feed(over: Partial<EventFeed> = {}): EventFeed {
  return {
    v: 1,
    eventId: EVENT,
    title: "T",
    description: "",
    imageHash: "00".repeat(32),
    startDate: "2099-01-01T00:00:00.000Z",
    endDate: "2099-01-02T00:00:00.000Z",
    location: "L",
    creatorAddress: CREATOR as EventFeed["creatorAddress"],
    createdAt: "2026-01-01T00:00:00.000Z",
    series: [],
    encryptionKeyRef: K0,
    creatorFeedSigner: F0 as EventFeed["creatorFeedSigner"],
    ...over,
  } as EventFeed;
}

beforeEach(() => {
  process.chdir(dir);
  rmSync(join(dir, ".data"), { recursive: true, force: true });
  record.__resetFeedSignerRecordForTest();
  process.chdir(originalCwd);
  ringOf = new Map();
  stubRings();
  service.invalidateEventCache(EVENT);
});

test("record: the order key validated at create is kept, and only identical values re-record", () => {
  process.chdir(dir);
  try {
    record.recordEventFeedSigner(EVENT, F0, CREATOR, K0);
    assert.equal(record.getRecordedFeedSigner(EVENT)?.orderKeyRef, K0);
    record.recordEventFeedSigner(EVENT, F0, CREATOR, K0);
    assert.throws(() => record.recordEventFeedSigner(EVENT, F0, CREATOR, K1), /already has a recorded feed signer/);
    assert.throws(() => record.recordEventFeedSigner("e2", F0, CREATOR, "XX"), /64 lowercase hex/);
  } finally {
    process.chdir(originalCwd);
  }
});

test("no ring: the record's keys stand; a feed naming another order key is served the record's", async () => {
  process.chdir(dir);
  record.recordEventFeedSigner(EVENT, F0, CREATOR, K0);
  process.chdir(originalCwd);
  const keys = await keysMod.eventKeys(EVENT);
  assert.deepEqual(keys, { kind: "record", creator: CREATOR, feedSigner: F0, orderKeyRef: K0 });
  assert.equal(keysMod.withAuthoritativeOrderKey(EVENT, feed({ encryptionKeyRef: K1 }), keys).encryptionKeyRef, K0);
  assert.equal(keysMod.feedSignerFor(keys, F0), F0);
});

test("legacy (no record) and unreadable keys never substitute", async () => {
  const legacy = await keysMod.eventKeys(EVENT);
  assert.deepEqual(legacy, { kind: "legacy" });
  assert.equal(keysMod.withAuthoritativeOrderKey(EVENT, feed({ encryptionKeyRef: K1 }), legacy).encryptionKeyRef, K1);
  process.chdir(dir);
  record.recordEventFeedSigner(EVENT, F0, CREATOR, K0);
  process.chdir(originalCwd);
  ringOf.set(CREATOR, "down");
  const down = await keysMod.eventKeys(EVENT);
  assert.equal(down.kind, "unavailable");
  assert.equal(keysMod.authoritativeOrderKeyRef(down), null);
});

test("creating under keys the account has left is refused before anything is written", async () => {
  // Keys that cannot be read (nothing seen yet) refuse the create; no ring lets anything through.
  ringOf.set(CREATOR, "down");
  await assert.rejects(keysMod.assertCurrentKeys(CREATOR, F0, K0), keysMod.AccountKeysUnavailableError);
  ringOf.delete(CREATOR);
  stubRings();
  await keysMod.assertCurrentKeys(CREATOR, F0, K0);
});

// The ring-backed cases need a real ring at the anchor: build one through the shared
// primitives and serve its chunks.
const { buildKeyRing, encodeKeyRing, NO_RING, boxKeyRefOf } = await import("@woco/shared/keyring/ring");
const { newAccountSecret, passkeyBoxKeypair, accountKeysOf } = await import("@woco/shared/keyring/account-secret");
const { signBoxKeyStatement } = await import("@woco/shared/keyring/box-key");
const { bytesTreeChunks, bytesTreeRoot } = await import("@woco/shared/swarm/bytes-tree");
const { Wallet } = await import("ethers");

async function realRing(account: string): Promise<{ ref: string; feedSigner: string; orderKeyRef: string }> {
  const priv = new Uint8Array(32).fill(3);
  const coOwner = new Wallet(`0x${"03".repeat(32)}`).address.toLowerCase();
  const box = passkeyBoxKeypair(new Uint8Array(32).fill(5));
  const secret = newAccountSecret();
  const ring = await buildKeyRing({
    parent: account,
    gen: 1,
    prev: NO_RING,
    secret,
    prior: [newAccountSecret()],
    members: [{ statement: signBoxKeyStatement({ parent: account, coOwner, boxKeyRef: boxKeyRefOf(box.publicKey), issuedAt: 1 }, priv), boxPublicKey: box.publicKey }],
  });
  const bytes = encodeKeyRing(ring);
  const chunks = new Map(bytesTreeChunks(bytes).map((c) => [c.address, c.chunk]));
  const ref = bytesTreeRoot(bytes);
  ringRead._setCurrentRingDepsForTests({
    readAnchor: async (a) => (a === account ? `0x${ref}` : `0x${"0".repeat(64)}`),
    fetchChunk: async (addr) => chunks.get(addr) ?? Promise.reject(new Error("absent")),
  });
  const k = accountKeysOf(secret);
  return { ref, feedSigner: k.feedSigner.address, orderKeyRef: k.orderKeyRef };
}

test("a ring: the event is read under the ring's signer and sold under its order key", async () => {
  process.chdir(dir);
  record.recordEventFeedSigner(EVENT, F0, CREATOR, K0);
  process.chdir(originalCwd);
  const r = await realRing(CREATOR);
  const keys = await keysMod.eventKeys(EVENT);
  assert.equal(keys.kind, "ring");
  assert.equal(keysMod.feedSignerFor(keys, F0), r.feedSigner);
  assert.equal(keysMod.withAuthoritativeOrderKey(EVENT, feed(), keys).encryptionKeyRef, r.orderKeyRef);
  // Creating under the old generation is refused; under the ring's keys it passes.
  await assert.rejects(keysMod.assertCurrentKeys(CREATOR, F0, r.orderKeyRef), keysMod.AccountKeysChangedError);
  await assert.rejects(keysMod.assertCurrentKeys(CREATOR, r.feedSigner, K0), keysMod.AccountKeysChangedError);
  await keysMod.assertCurrentKeys(CREATOR, r.feedSigner, r.orderKeyRef);
});

test("the money-path cache: an entry read under the old signer is a miss once the account has a ring", async () => {
  process.chdir(dir);
  record.recordEventFeedSigner(EVENT, F0, CREATOR, K0);
  process.chdir(originalCwd);
  service.primeEventCache(EVENT, feed());
  assert.equal((await service.getEvent(EVENT))?.encryptionKeyRef, K0);

  const r = await realRing(CREATOR);
  // A feed primed under the RING's signer is served, with the ring's order key.
  service.primeEventCache(EVENT, feed({ creatorFeedSigner: r.feedSigner as EventFeed["creatorFeedSigner"], encryptionKeyRef: K0 }));
  assert.equal((await service.getEvent(EVENT))?.encryptionKeyRef, r.orderKeyRef);
  // One primed under the OLD signer is not served from the cache.
  service.primeEventCache(EVENT, feed());
  const t = Date.now();
  const read = await service.getEvent(EVENT);
  assert.notEqual(read?.creatorFeedSigner, F0, `served the old generation's feed (${Date.now() - t} ms)`);
});

test("checkout: a box sealed to anything but the current key is stale once the account has a ring", () => {
  const ring = { kind: "ring", creator: CREATOR, feedSigner: F1, orderKeyRef: K1, gen: 1 } as const;
  assert.equal(keysMod.isStaleOrderKey(ring, K1), false);
  assert.equal(keysMod.isStaleOrderKey(ring, K0), true, "the old generation's key");
  assert.equal(keysMod.isStaleOrderKey(ring, undefined), true, "undeclared: a client from before the ring");
  const rec = { kind: "record", creator: CREATOR, feedSigner: F0, orderKeyRef: K0 } as const;
  assert.equal(keysMod.isStaleOrderKey(rec, undefined), false, "no ring: an older client still sells");
  assert.equal(keysMod.isStaleOrderKey(rec, K0), false);
  assert.equal(keysMod.isStaleOrderKey(rec, K1), true);
  assert.equal(keysMod.isStaleOrderKey({ kind: "record", creator: CREATOR, feedSigner: F0, orderKeyRef: null }, K1), false);
  assert.equal(keysMod.isStaleOrderKey({ kind: "legacy" }, K1), false);
});


test("keys that cannot be read: the feed is not read at all (never under the old signer)", async () => {
  process.chdir(dir);
  record.recordEventFeedSigner(EVENT, F0, CREATOR, K0);
  process.chdir(originalCwd);
  ringOf.set(CREATOR, "down");
  stubRings();
  const r = await service.readEventFeedSocResult(EVENT, F0);
  assert.equal(r.status, "unavailable");
  assert.match(r.status === "unavailable" ? r.reason : "", /organiser keys unreadable/);
  // getEvent: nothing cached, so nothing served - and fast, no platform-feed ladder.
  const t = Date.now();
  assert.equal(await service.getEvent(EVENT), null);
  assert.ok(Date.now() - t < 2000, "returned without the retry ladder");
});

test("owner reads follow the same key rule as the money path (no old-generation cache entry)", async () => {
  process.chdir(dir);
  record.recordEventFeedSigner(EVENT, F0, CREATOR, K0);
  process.chdir(originalCwd);
  service.primeEventCache(EVENT, feed());
  assert.equal((await service.resolveOwnEventLocally(EVENT, CREATOR))?.creatorFeedSigner, F0, "no ring: served");
  const r = await realRing(CREATOR);
  const t = Date.now();
  const after = await service.resolveOwnEventLocally(EVENT, CREATOR);
  assert.notEqual(after?.creatorFeedSigner, F0, `served the old generation's entry (${Date.now() - t} ms)`);
  service.primeEventCache(EVENT, feed({ creatorFeedSigner: r.feedSigner as EventFeed["creatorFeedSigner"] }));
  assert.equal((await service.resolveOwnEventLocally(EVENT, CREATOR))?.encryptionKeyRef, r.orderKeyRef);
});
