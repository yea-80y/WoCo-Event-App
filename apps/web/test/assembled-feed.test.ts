/**
 * Before signing a server-assembled event feed as its own SOC, the client refuses
 * it unless the fields a signature would vouch for are what it sent (#642).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import { orderKeyRef, type CreateEventV3Request, type EventFeed } from "@woco/shared";
import { deriveXWingKeypairFromSeed } from "@woco/shared/crypto/xwing";
import { assertAssembledFeedMatches, assertFeedIsOurs } from "../src/lib/api/assembled-feed.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

// ── Every re-sign path (Fable sign-off F1) ──────────────────────────────────
// The feed signed after on-chain registration, edits, cancel, delete and the
// sub-ENS stamp are all server-assembled too. The same guard runs on each.

const OWN_REF = orderKeyRef(KEY);

test("a re-sign is refused when the server swapped the order key, even though the create response was clean", () => {
  const registered = { ...good, onChainEventId: "0x" + "12".repeat(32) } as unknown as EventFeed;
  assert.doesNotThrow(() => assertFeedIsOurs(registered, { ...OWN, orderKeyRef: OWN_REF }));
  const swapped = { ...registered, encryptionKeyRef: orderKeyRef(deriveXWingKeypairFromSeed("0x" + "33".repeat(32)).publicKey) };
  assert.throws(() => assertFeedIsOurs(swapped as EventFeed, { ...OWN, orderKeyRef: OWN_REF }), /order key/);
  assert.throws(() => assertFeedIsOurs({ ...registered, encryptionKey: "ab" } as unknown as EventFeed, { ...OWN, orderKeyRef: OWN_REF }), /order key/);
  assert.throws(() => assertFeedIsOurs({ ...registered, creatorFeedSigner: "0x" + "cc".repeat(20) } as EventFeed, { ...OWN, orderKeyRef: OWN_REF }), /feed signer/);
  assert.throws(() => assertFeedIsOurs({ ...registered, creatorAddress: "0x" + "dd".repeat(20) } as EventFeed, { ...OWN, orderKeyRef: OWN_REF }), /creator/);
});

test("a feed with no order key at all may be signed (events published without one)", () => {
  const keyless = { ...good, encryptionKeyRef: undefined } as unknown as EventFeed;
  assert.doesNotThrow(() => assertFeedIsOurs(keyless, { ...OWN, orderKeyRef: undefined }));
});

test("signEventFeedSoc checks BEFORE writing, and the publish flow's re-sign goes through it", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  const events = read("../src/lib/api/events.ts");
  const body = events.slice(events.indexOf("export async function signEventFeedSoc("));
  const check = body.indexOf("assertFeedIsOurs(feed,");
  const write = body.indexOf("writeContentFeed(");
  assert.ok(check > 0 && write > check, "the guard runs before the SOC is written");
  // No other event-feed SOC write exists in the app: every path signs through here.
  const publish = read("../src/lib/creator/events/PublishButton.svelte");
  assert.match(publish, /await signEventFeedSoc\(feed, signer, next\)/);
  assert.doesNotMatch(publish, /writeContentFeed\(/);
});
