/**
 * The account secret, box keys and key ring (#186).
 *
 *  - `keyring-v1-vectors.json` pins every frozen label through its OUTPUT (a one-byte
 *    change anywhere moves a key, a ref or an AAD), and holds one ring sealed before
 *    the format was frozen: it must open with this build for as long as v1 is read.
 *  - Box-key signatures are cross-checked against ethers' `signTypedData`, a separate
 *    EIP-712 implementation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Wallet, verifyTypedData } from "ethers";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { deriveFeedSignerKey } from "../../src/crypto/feed-signer.js";
import { deriveXWingKeypairFromSeed } from "../../src/crypto/xwing.js";
import { orderKeyRef } from "../../src/event/order-key.js";
import { PASSKEY_BOX_INFO } from "../../src/crypto/passkey-prf.js";
import {
  DOOR_PASS_ROSTER_INFO,
  accountKeysOf,
  doorPassRosterKey,
  newAccountSecret,
  passkeyBoxKeypair,
} from "../../src/keyring/account-secret.js";
import {
  BOX_KEY_DOMAIN,
  BOX_KEY_TYPES,
  parseBoxKeyStatement,
  signBoxKeyStatement,
  verifyBoxKeyStatement,
  type BoxKeyStatement,
} from "../../src/keyring/box-key.js";
import {
  KEY_RING_BACK_INFO,
  KEY_RING_ENTRY_INFO,
  KeyRingOpenError,
  MAX_KEY_RING_BYTES,
  MAX_KEY_RING_GEN,
  MalformedKeyRingError,
  NO_RING,
  UnsupportedKeyRingError,
  boxKeyRefOf,
  buildKeyRing,
  coOwnersWithoutEntry,
  encodeKeyRing,
  keyRingBackAad,
  keyRingEntryContext,
  openKeyRing,
  parseKeyRing,
  type KeyRing,
} from "../../src/keyring/ring.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const V = JSON.parse(readFileSync(here("./keyring-v1-vectors.json"), "utf8"));

// ---------------------------------------------------------------------------
// Frozen labels and derivations
// ---------------------------------------------------------------------------

test("FROZEN: labels, domain and type, byte for byte", () => {
  assert.equal(PASSKEY_BOX_INFO, "woco/passkey/box/v1");
  assert.equal(KEY_RING_ENTRY_INFO, "woco/keyring/entry/v1");
  assert.equal(KEY_RING_BACK_INFO, "woco/keyring/back/v1");
  assert.equal(DOOR_PASS_ROSTER_INFO, "woco/door-pass/roster/v1");
  assert.deepEqual(BOX_KEY_DOMAIN, {
    name: "WoCo Box Key",
    version: "1",
    chainId: 42161,
    salt: "0x34b468d42a01f3c5e4454207aced58d78bdb2859507db8fca3de40f58d5277ad",
  });
  assert.deepEqual(BOX_KEY_TYPES.BoxKey.map((f) => `${f.type} ${f.name}`), [
    "address parent",
    "address coOwner",
    "bytes32 boxKeyRef",
    "uint256 issuedAt",
  ]);
  assert.equal(NO_RING, `0x${"0".repeat(64)}`);
});

test("FROZEN: a generation's keys, a roster key, a box key and the contexts, by output", () => {
  const secret = hexToBytes(V.secret);
  const k = accountKeysOf(secret);
  assert.equal(k.feedSigner.address, V.feedSigner);
  assert.equal(k.orderKeyRef, V.orderKeyRef);
  assert.equal(bytesToHex(doorPassRosterKey(secret, V.rosterKey.eventId, V.rosterKey.passId)), V.rosterKey.key);
  assert.equal(boxKeyRefOf(passkeyBoxKeypair(V.prf).publicKey), V.boxKeyRef);
  assert.equal(keyRingEntryContext(V.parent, 3, V.coOwner, V.boxKeyRef).aad, V.entryAad);
  assert.equal(keyRingBackAad(V.parent, 3), V.backAad);
});

test("generation 0 changes nothing: the seed's keys are exactly today's", () => {
  const seed = newAccountSecret();
  const hex = bytesToHex(seed);
  const k = accountKeysOf(seed);
  assert.equal(k.feedSigner.address, deriveFeedSignerKey(hex).address);
  assert.equal(k.orderKeyRef, orderKeyRef(deriveXWingKeypairFromSeed(hex).publicKey));
});

test("a roster key differs per event and per pass, and refuses ids that could collide", () => {
  const s = newAccountSecret();
  const a = bytesToHex(doorPassRosterKey(s, "ev-1", "p1"));
  assert.notEqual(a, bytesToHex(doorPassRosterKey(s, "ev-1", "p2")));
  assert.notEqual(a, bytesToHex(doorPassRosterKey(s, "ev-2", "p1")));
  assert.throws(() => doorPassRosterKey(s, "ev:1", "p1"), /ids/);
  assert.throws(() => doorPassRosterKey(s, "ev-1", ""), /ids/);
});

test("the box key is not the seed's or the envelope's key", () => {
  const prf = "0x" + "77".repeat(32);
  const box = passkeyBoxKeypair(prf);
  const seedKey = deriveXWingKeypairFromSeed(bytesToHex(hexToBytes("77".repeat(32))));
  assert.notEqual(bytesToHex(box.publicKey), bytesToHex(seedKey.publicKey));
});

// ---------------------------------------------------------------------------
// Box-key statements
// ---------------------------------------------------------------------------

function passkey(n: number) {
  const priv = new Uint8Array(32).fill(n);
  const wallet = new Wallet(`0x${bytesToHex(priv)}`);
  const box = passkeyBoxKeypair(new Uint8Array(32).fill(100 + n));
  return { priv, address: wallet.address.toLowerCase(), wallet, box };
}

const PARENT = "0x" + "ab".repeat(20);

function statementFor(p: ReturnType<typeof passkey>, parent = PARENT): BoxKeyStatement {
  return signBoxKeyStatement({ parent, coOwner: p.address, boxKeyRef: boxKeyRefOf(p.box.publicKey), issuedAt: 1760000000 }, p.priv);
}

test("a box-key statement is ethers' signTypedData, byte for byte, and verifies under ethers", async () => {
  const p = passkey(5);
  const s = statementFor(p);
  const msg = { parent: s.parent, coOwner: s.coOwner, boxKeyRef: s.boxKeyRef, issuedAt: s.issuedAt };
  const types = { BoxKey: [...BOX_KEY_TYPES.BoxKey] };
  assert.equal(await p.wallet.signTypedData(BOX_KEY_DOMAIN, types, msg), s.sig);
  assert.equal(verifyTypedData(BOX_KEY_DOMAIN, types, msg, s.sig).toLowerCase(), p.address);
  assert.deepEqual(verifyBoxKeyStatement(V.boxKeyStatement), V.boxKeyStatement);
});

test("a statement verifies only for the key that signed it, unaltered", () => {
  const a = passkey(1);
  const b = passkey(2);
  const s = statementFor(a);
  assert.ok(verifyBoxKeyStatement(s));
  // Another passkey cannot state a key in a's name.
  assert.throws(() => signBoxKeyStatement({ ...s, coOwner: a.address }, b.priv), /not the stated co-owner/);
  for (const forged of [
    { ...s, coOwner: b.address },
    { ...s, boxKeyRef: boxKeyRefOf(b.box.publicKey) },
    { ...s, parent: "0x" + "cd".repeat(20) },
    { ...s, issuedAt: s.issuedAt + 1 },
  ]) {
    assert.equal(verifyBoxKeyStatement(forged), null);
  }
});

test("a statement's shape is closed and lowercase, and a malleable signature is refused", () => {
  const s = statementFor(passkey(3));
  assert.equal(parseBoxKeyStatement({ ...s, extra: 1 }), null);
  assert.equal(parseBoxKeyStatement({ ...s, coOwner: s.coOwner.toUpperCase().replace("0X", "0x") }), null);
  assert.equal(parseBoxKeyStatement({ ...s, coOwner: s.parent }), null);
  assert.equal(parseBoxKeyStatement({ ...s, issuedAt: -1 }), null);
  // The high-s twin of the same signature recovers the same key on a lax verifier.
  const n = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
  const r = s.sig.slice(2, 66);
  const sLow = BigInt("0x" + s.sig.slice(66, 130));
  const v = parseInt(s.sig.slice(130), 16);
  const twin = `0x${r}${(n - sLow).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}`;
  assert.equal(verifyBoxKeyStatement({ ...s, sig: twin }), null);
});

// ---------------------------------------------------------------------------
// Rings
// ---------------------------------------------------------------------------

test("FROZEN: the ring sealed when v1 was frozen still opens, to the same keys", async () => {
  const ring = parseKeyRing(V.frozenRing);
  const opened = await openKeyRing(ring, {
    expectedParent: V.parent,
    coOwner: V.coOwner,
    boxSecretKey: passkeyBoxKeypair(V.prf).secretKey,
  });
  assert.equal(opened.gen, 2);
  assert.equal(bytesToHex(opened.secret), V.secret);
  assert.deepEqual(opened.prior.map((s) => (s ? bytesToHex(s) : null)), ["44".repeat(32), "55".repeat(32)]);
});

test("first add, then a removal: the removed passkey is left out of the new generation", async () => {
  const [a, b, c] = [passkey(1), passkey(2), passkey(3)];
  const s0 = newAccountSecret();
  const members = (ps: ReturnType<typeof passkey>[]) => ps.map((p) => ({ statement: statementFor(p), boxPublicKey: p.box.publicKey }));

  // Gen 0 at the first add: the seed, sealed to both passkeys.
  const r0 = await buildKeyRing({ parent: PARENT, gen: 0, prev: NO_RING, secret: s0, prior: [], members: members([a, b]) });
  // A third passkey: same generation, one more entry.
  const r0b = await buildKeyRing({ parent: PARENT, gen: 0, prev: "0x" + "01".repeat(32), secret: s0, prior: [], members: members([a, b, c]) });
  assert.equal(r0b.feedSigner, r0.feedSigner);
  // c is removed by a: gen 1, fresh secret, no entry for c.
  const s1 = newAccountSecret();
  const r1 = await buildKeyRing({ parent: PARENT, gen: 1, prev: "0x" + "02".repeat(32), secret: s1, prior: [s0], members: members([a, b]) });

  assert.notEqual(r1.feedSigner, r0.feedSigner);
  assert.notEqual(r1.orderKeyRef, r0.orderKeyRef);
  for (const p of [a, b]) {
    const o = await openKeyRing(r1, { expectedParent: PARENT, coOwner: p.address, boxSecretKey: p.box.secretKey });
    assert.equal(bytesToHex(o.secret), bytesToHex(s1));
    assert.equal(bytesToHex(o.prior[0]!), bytesToHex(s0));
  }
  await assert.rejects(
    openKeyRing(r1, { expectedParent: PARENT, coOwner: c.address, boxSecretKey: c.box.secretKey }),
    (e: unknown) => e instanceof KeyRingOpenError && e.reason === "not-enrolled",
  );
  // c's own key opens nothing in the new ring, under any passkey's entry.
  for (const p of [a, b]) {
    await assert.rejects(
      openKeyRing(r1, { expectedParent: PARENT, coOwner: p.address, boxSecretKey: c.box.secretKey }),
      (e: unknown) => e instanceof KeyRingOpenError && e.reason === "wrong-key",
    );
  }
  assert.deepEqual(coOwnersWithoutEntry(r1, [a.address, b.address, c.address]), [c.address]);
});

test("a ring opens only for its own account", async () => {
  const a = passkey(1);
  const r = await buildKeyRing({
    parent: PARENT,
    gen: 0,
    prev: NO_RING,
    secret: newAccountSecret(),
    prior: [],
    members: [{ statement: statementFor(a), boxPublicKey: a.box.publicKey }],
  });
  await assert.rejects(
    openKeyRing(r, { expectedParent: "0x" + "cd".repeat(20), coOwner: a.address, boxSecretKey: a.box.secretKey }),
    (e: unknown) => e instanceof KeyRingOpenError && e.reason === "other-account",
  );
});

async function twoPasskeyRing(): Promise<{ ring: KeyRing; a: ReturnType<typeof passkey>; b: ReturnType<typeof passkey> }> {
  const a = passkey(1);
  const b = passkey(2);
  const ring = await buildKeyRing({
    parent: PARENT,
    gen: 1,
    prev: NO_RING,
    secret: newAccountSecret(),
    prior: [newAccountSecret()],
    members: [a, b].map((p) => ({ statement: statementFor(p), boxPublicKey: p.box.publicKey })),
  });
  return { ring, a, b };
}

test("an entry moved under another passkey's statement fails its tag", async () => {
  const { ring, a, b } = await twoPasskeyRing();
  const swapped = structuredClone(ring);
  [swapped.entries[0]!.box, swapped.entries[1]!.box] = [swapped.entries[1]!.box, swapped.entries[0]!.box];
  for (const p of [a, b]) {
    await assert.rejects(
      openKeyRing(parseKeyRing(swapped), { expectedParent: PARENT, coOwner: p.address, boxSecretKey: p.box.secretKey }),
      (e: unknown) => e instanceof KeyRingOpenError && e.reason === "wrong-key",
    );
  }
});

test("a ring whose stated keys are not its secret's is never adopted", async () => {
  const { ring, a } = await twoPasskeyRing();
  for (const lie of [{ feedSigner: "0x" + "99".repeat(20) }, { orderKeyRef: "99".repeat(32) }]) {
    await assert.rejects(
      openKeyRing(parseKeyRing({ ...ring, ...lie }), { expectedParent: PARENT, coOwner: a.address, boxSecretKey: a.box.secretKey }),
      (e: unknown) => e instanceof KeyRingOpenError && e.reason === "key-mismatch",
    );
  }
  // Another ring's back blob is sealed under another secret: refused, not misread.
  const other = await twoPasskeyRing();
  await assert.rejects(
    openKeyRing(parseKeyRing({ ...ring, back: other.ring.back }), { expectedParent: PARENT, coOwner: a.address, boxSecretKey: a.box.secretKey }),
    (e: unknown) => e instanceof KeyRingOpenError && e.reason === "key-mismatch",
  );
});

test("holes: a generation the writer never had stays null, never zero bytes", async () => {
  const a = passkey(1);
  const s0 = newAccountSecret();
  const r = await buildKeyRing({
    parent: PARENT,
    gen: 3,
    prev: NO_RING,
    secret: newAccountSecret(),
    prior: [s0, null, newAccountSecret()],
    members: [{ statement: statementFor(a), boxPublicKey: a.box.publicKey }],
  });
  assert.deepEqual(r.back.holes, [1]);
  const o = await openKeyRing(r, { expectedParent: PARENT, coOwner: a.address, boxSecretKey: a.box.secretKey });
  assert.equal(bytesToHex(o.prior[0]!), bytesToHex(s0));
  assert.equal(o.prior[1], null);
  await assert.rejects(
    buildKeyRing({ parent: PARENT, gen: 1, prev: NO_RING, secret: newAccountSecret(), prior: [null], members: [{ statement: statementFor(a), boxPublicKey: a.box.publicKey }] }),
    /every earlier generation is a hole/,
  );
});

test("the writer refuses a member whose key is not the one its statement names, or another account's", async () => {
  const a = passkey(1);
  const b = passkey(2);
  const base = { parent: PARENT, gen: 0, prev: NO_RING, secret: newAccountSecret(), prior: [] };
  await assert.rejects(buildKeyRing({ ...base, members: [{ statement: statementFor(a), boxPublicKey: b.box.publicKey }] }), /does not match/);
  await assert.rejects(
    buildKeyRing({ ...base, members: [{ statement: statementFor(a, "0x" + "cd".repeat(20)), boxPublicKey: a.box.publicKey }] }),
    /another account/,
  );
  await assert.rejects(buildKeyRing({ ...base, prior: [newAccountSecret()], members: [] }), /needs exactly 0/);
});

test("parse: closed schema, exact sizes, and a newer version is refused, never read as v1", async () => {
  const { ring } = await twoPasskeyRing();
  const bytes = encodeKeyRing(ring);
  assert.deepEqual(parseKeyRing(bytes), ring);
  assert.throws(() => parseKeyRing({ ...ring, v: 2 }), UnsupportedKeyRingError);
  const bad: unknown[] = [
    { ...ring, extra: 1 },
    { ...ring, entries: [] },
    { ...ring, entries: Array(11).fill(ring.entries[0]) },
    { ...ring, entries: [ring.entries[0], ring.entries[0]] },
    { ...ring, entries: [{ ...ring.entries[0], statement: { ...ring.entries[0]!.statement, issuedAt: 1 } }] },
    { ...ring, entries: [{ ...ring.entries[0], box: { ...ring.entries[0]!.box, ct: ring.entries[0]!.box.ct + "00" } }] },
    { ...ring, back: { ...ring.back, ct: ring.back.ct.slice(2) } },
    { ...ring, back: { ...ring.back, holes: [1] } },
    { ...ring, back: { ...ring.back, holes: [0] } },
    { ...ring, gen: 2 },
    { ...ring, prev: "0x12" },
    { ...ring, parent: ring.parent.toUpperCase() },
  ];
  bad.push(
    // A key swapped in under another passkey's signed statement.
    { ...ring, entries: [{ ...ring.entries[0], boxKey: ring.entries[1]!.boxKey }, ring.entries[1]] },
    { ...ring, entries: [{ ...ring.entries[0], boxKey: ring.entries[0]!.boxKey.slice(2) }] },
  );
  for (const x of bad) assert.throws(() => parseKeyRing(x), MalformedKeyRingError);
  // A properly signed statement, but for another account.
  const a = passkey(1);
  const foreign = statementFor(a, "0x" + "cd".repeat(20));
  assert.throws(() => parseKeyRing({ ...ring, entries: [{ ...ring.entries[0], statement: foreign }] }), /names another account/);
  // Holes must be ascending, distinct and below gen.
  const three = await buildKeyRing({
    parent: PARENT,
    gen: 3,
    prev: NO_RING,
    secret: newAccountSecret(),
    prior: [newAccountSecret(), null, null],
    members: [{ statement: statementFor(a), boxPublicKey: a.box.publicKey }],
  });
  assert.deepEqual(three.back.holes, [1, 2]);
  await assert.rejects(
    buildKeyRing({ parent: PARENT, gen: 2, prev: NO_RING, secret: newAccountSecret(), prior: [null, newAccountSecret()], members: [{ statement: statementFor(a), boxPublicKey: a.box.publicKey }] }),
    /generation 0/,
  );
  for (const holes of [[2, 1], [1, 1], [1, 3], [0, 1], [0]]) {
    assert.throws(() => parseKeyRing({ ...three, back: { ...three.back, holes } }), MalformedKeyRingError);
  }
  assert.throws(() => parseKeyRing(new Uint8Array([0xff, 0xfe])), MalformedKeyRingError);
});

test("the next writer's members come from the ring alone, less the removed passkey", async () => {
  const { ring, a, b } = await twoPasskeyRing();
  const { keyRingMembers } = await import("../../src/keyring/ring.js");
  const next = keyRingMembers(ring, [b.address.toUpperCase().replace("0X", "0x")]);
  assert.deepEqual(next.map((m) => m.statement.coOwner), [a.address]);
  assert.equal(bytesToHex(next[0]!.boxPublicKey), bytesToHex(a.box.publicKey));
  const r2 = await buildKeyRing({ parent: PARENT, gen: 2, prev: NO_RING, secret: newAccountSecret(), prior: [newAccountSecret(), newAccountSecret()], members: next });
  await assert.rejects(
    openKeyRing(r2, { expectedParent: PARENT, coOwner: b.address, boxSecretKey: b.box.secretKey }),
    (e: unknown) => e instanceof KeyRingOpenError && e.reason === "not-enrolled",
  );
});


test("the largest ring the format allows - ten passkeys at the last generation - fits the size bound, in one tree level", async () => {
  const ten = Array.from({ length: 10 }, (_, i) => passkey(i + 1));
  const ring = await buildKeyRing({
    parent: PARENT,
    gen: MAX_KEY_RING_GEN,
    prev: NO_RING,
    secret: newAccountSecret(),
    prior: Array.from({ length: MAX_KEY_RING_GEN }, () => newAccountSecret()),
    members: ten.map((p) => ({ statement: statementFor(p), boxPublicKey: p.box.publicKey })),
  });
  const size = encodeKeyRing(ring).length;
  assert.ok(size <= MAX_KEY_RING_BYTES, `${size} bytes`);
  assert.ok(MAX_KEY_RING_BYTES <= 128 * 4096, "one intermediate chunk of leaves");
});
