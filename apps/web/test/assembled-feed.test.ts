/**
 * Before signing a server-assembled event feed as its own SOC, the client refuses
 * it unless the fields a signature would vouch for are what it sent (#642).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import { orderKeyRef, type CreateEventV3Request, type EventFeed } from "@woco/shared";
import { deriveXWingKeypairFromSeed } from "@woco/shared/crypto/xwing";
import { assertAssembledFeedMatches } from "../src/lib/api/assembled-feed.js";

const KEY = deriveXWingKeypairFromSeed("0x" + "31".repeat(32)).publicKey;
const OWN = { feedSigner: "0x" + "aa".repeat(20), parent: "0x" + "bb".repeat(20) };
const FIELDS = [{ id: "__email", type: "email" as const, label: "Email", required: true }];

const req = { encryptionPublicKey: bytesToHex(KEY), orderFields: FIELDS } as unknown as CreateEventV3Request;
const good = {
  encryptionKeyRef: orderKeyRef(KEY),
  creatorFeedSigner: OWN.feedSigner,
  creatorAddress: OWN.parent.toUpperCase().replace("0X", "0x"),
  orderFields: FIELDS,
} as unknown as EventFeed;

test("a feed carrying exactly what we sent is accepted", () => {
  assert.doesNotThrow(() => assertAssembledFeedMatches(req, good, OWN));
});

test("a feed naming another order key, or none, or the retired inline key, is refused", () => {
  const otherRef = orderKeyRef(deriveXWingKeypairFromSeed("0x" + "32".repeat(32)).publicKey);
  for (const feed of [
    { ...good, encryptionKeyRef: otherRef },
    { ...good, encryptionKeyRef: undefined },
    { ...good, encryptionKey: "ab".repeat(32) },
  ]) {
    assert.throws(() => assertAssembledFeedMatches(req, feed as EventFeed, OWN), /order key/);
  }
  // And a key we never sent must not appear either.
  const noKeyReq = { orderFields: FIELDS } as unknown as CreateEventV3Request;
  assert.throws(() => assertAssembledFeedMatches(noKeyReq, good, OWN), /order key/);
});

test("another signer, another creator, or another order form is refused", () => {
  assert.throws(() => assertAssembledFeedMatches(req, { ...good, creatorFeedSigner: "0x" + "cc".repeat(20) } as EventFeed, OWN), /feed signer/);
  assert.throws(() => assertAssembledFeedMatches(req, { ...good, creatorAddress: "0x" + "dd".repeat(20) } as EventFeed, OWN), /creator/);
  assert.throws(() => assertAssembledFeedMatches(req, { ...good, orderFields: [] } as unknown as EventFeed, OWN), /order form/);
});
