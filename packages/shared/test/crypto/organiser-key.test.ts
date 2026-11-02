/**
 * The organiser key (ledger2 terms signer). The golden vector pins the derivation: if it
 * moves, every event's on-chain organiser key becomes one nobody can derive, and the
 * organiser's terms are frozen until its account re-points them. That is not a test
 * update.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAddress, Wallet } from "ethers";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  buildOrganiserKeyBindingMessage,
  deriveOrganiserKey,
  ORGANISER_KEY_BINDING_DOMAIN,
  ORGANISER_KEY_INFO,
  signOrganiserKeyBinding,
  verifyOrganiserKeyBinding,
} from "../../src/crypto/organiser-key.js";
import { deriveFeedSignerKey } from "../../src/crypto/feed-signer.js";
import { deriveIssuingKey } from "../../src/crypto/issuing.js";

const SECRET = "0x" + "ab".repeat(32);
const OTHER_SECRET = "0x" + "cd".repeat(32);
const PARENT = "0x" + "1a".repeat(20);
const OTHER_PARENT = "0x" + "2b".repeat(20);

test("golden: fixed secret → pinned organiser key and address", () => {
  const { privateKey, address } = deriveOrganiserKey(SECRET);
  assert.equal(
    "0x" + bytesToHex(privateKey),
    "0xbe2fb03d3a7f4e09abf15da30b6fd53d931b36bb7fea01230d8f204a2e38bd15",
    "organiser PRIVATE KEY moved: the HKDF info, salt or scalar map changed",
  );
  assert.equal(
    address,
    "0x0ef6f24aca5b9c7f9d057f808df31f8dca0dbd8f",
    "organiser ADDRESS moved: every event's on-chain key is orphaned",
  );
  assert.equal(address, computeAddress("0x" + bytesToHex(privateKey)).toLowerCase(), "address is not the key's");
  assert.equal(ORGANISER_KEY_INFO, "woco/organiser-key/v1");
});

test("independent of its siblings: never the feed signer or the issuing key of the same secret", () => {
  const organiser = deriveOrganiserKey(SECRET).address;
  assert.notEqual(organiser, deriveFeedSignerKey(SECRET).address);
  assert.notEqual(organiser, deriveIssuingKey(SECRET, 0).address.toLowerCase());
  assert.notEqual(organiser, deriveOrganiserKey(OTHER_SECRET).address);
});

test("binding message: exact bytes, and refuses a malformed parent or generation", () => {
  assert.equal(buildOrganiserKeyBindingMessage(PARENT, 3), `woco-organiser-key-binding-v1\n${PARENT}\n3`);
  assert.equal(ORGANISER_KEY_BINDING_DOMAIN, "woco-organiser-key-binding-v1");
  assert.throws(() => buildOrganiserKeyBindingMessage(PARENT.toUpperCase().replace("0X", "0x"), 0));
  assert.throws(() => buildOrganiserKeyBindingMessage("0x1234", 0));
  assert.throws(() => buildOrganiserKeyBindingMessage(PARENT, -1));
  assert.throws(() => buildOrganiserKeyBindingMessage(PARENT, 1.5));
  // The shortest message is far from a 32-byte digest.
  assert.equal(utf8ToBytes(buildOrganiserKeyBindingMessage("0x" + "00".repeat(20), 0)).length, 74);
});

test("a binding verifies for its parent and generation only", () => {
  const key = deriveOrganiserKey(SECRET);
  const binding = signOrganiserKeyBinding(key, PARENT, 2);
  assert.deepEqual(verifyOrganiserKeyBinding(binding, PARENT), { key: key.address, gen: 2 });
  assert.equal(verifyOrganiserKeyBinding(binding, OTHER_PARENT), null, "verified for another parent");
  assert.equal(verifyOrganiserKeyBinding({ ...binding, gen: 3 }, PARENT), null, "verified for another generation");
  // The parent checked is the one asked about, for any parent.
  const theirs = signOrganiserKeyBinding(key, OTHER_PARENT, 0);
  assert.deepEqual(verifyOrganiserKeyBinding(theirs, OTHER_PARENT), { key: key.address, gen: 0 });
  assert.equal(verifyOrganiserKeyBinding(theirs, PARENT), null);
});

test("a binding naming a key that did not sign it is refused", () => {
  const key = deriveOrganiserKey(SECRET);
  const other = deriveOrganiserKey(OTHER_SECRET);
  const binding = signOrganiserKeyBinding(key, PARENT, 0);
  assert.equal(verifyOrganiserKeyBinding({ ...binding, key: other.address }, PARENT), null);
});

test("ethers verifies the same signature: plain EIP-191, nothing WoCo-specific", () => {
  const key = deriveOrganiserKey(SECRET);
  const binding = signOrganiserKeyBinding(key, PARENT, 0);
  const wallet = new Wallet("0x" + bytesToHex(key.privateKey));
  assert.equal(wallet.address.toLowerCase(), key.address);
  // ethers' own signature verifies too.
  const message = buildOrganiserKeyBindingMessage(PARENT, 0);
  return wallet.signMessage(message).then((sig) => {
    assert.deepEqual(verifyOrganiserKeyBinding({ key: key.address, gen: 0, sig }, PARENT), { key: key.address, gen: 0 });
    assert.equal(sig.toLowerCase(), binding.sig, "the two signers disagree");
  });
});

test("malformed bindings are refused, never thrown", () => {
  const key = deriveOrganiserKey(SECRET);
  const good = signOrganiserKeyBinding(key, PARENT, 0);
  const bad: unknown[] = [
    null,
    undefined,
    "binding",
    {},
    { ...good, key: good.key.toUpperCase() },
    { ...good, key: "0x1234" },
    { ...good, gen: -1 },
    { ...good, gen: "0" },
    { ...good, sig: "0x00" },
    { ...good, sig: good.sig.slice(0, -2) + "1d" },
  ];
  for (const b of bad) assert.equal(verifyOrganiserKeyBinding(b, PARENT), null, JSON.stringify(b));
});
