/**
 * Passkeys going into the account's key ring (#186): only a passkey's own keys make its
 * member, the first ring is generation 0 (the seed), and a later add keeps the generation
 * and drops members whose key is no longer on the account's list.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Wallet, keccak256 } from "ethers";
import { bytesToHex } from "@noble/hashes/utils.js";
import { openKeyRing, type KeyRing } from "@woco/shared/keyring/ring";
import { verifyBoxKeyStatement } from "@woco/shared/keyring/box-key";
import { newAccountSecret, passkeyBoxKeypair } from "@woco/shared/keyring/account-secret";
import { memberOf, ringWithMembers } from "../src/lib/keyring/members.ts";

const PARENT = "0x" + "ab".repeat(20);
function passkey(n: number) {
  const prfSecret = "0x" + n.toString(16).padStart(2, "0").repeat(32);
  const privateKey = keccak256(prfSecret);
  return { prfSecret, privateKey, address: new Wallet(privateKey).address.toLowerCase() };
}
const hex = (b: Uint8Array) => `0x${bytesToHex(b)}`;
const A = passkey(1);
const B = passkey(2);
const C = passkey(3);
const SEED = hex(newAccountSecret());

async function opens(ring: KeyRing, p: ReturnType<typeof passkey>) {
  return openKeyRing(ring, { expectedParent: PARENT, coOwner: p.address, boxSecretKey: passkeyBoxKeypair(p.prfSecret).secretKey });
}

test("a member is the passkey's own: its key signs, its PRF gives the box key", async () => {
  const m = await memberOf(PARENT, A);
  assert.deepEqual(verifyBoxKeyStatement(m.statement), m.statement);
  assert.equal(m.statement.coOwner, A.address);
  assert.equal(bytesToHex(m.boxPublicKey), bytesToHex(passkeyBoxKeypair(A.prfSecret).publicKey));
});

test("the first ring is generation 0 - the seed - and opens for both passkeys", async () => {
  const ring = await ringWithMembers({ parent: PARENT, seed: SEED, chain: null, current: null, onChain: [A.address], add: [await memberOf(PARENT, A), await memberOf(PARENT, B)] });
  assert.equal(ring.gen, 0);
  for (const p of [A, B]) assert.equal(hex((await opens(ring, p)).secret), SEED);
});

test("a later add keeps the generation and its secret, and drops a member no longer on the list", async () => {
  const S1 = hex(newAccountSecret());
  const chain = { ringRef: "aa".repeat(32), gen: 1, secrets: [S1] };
  const { buildKeyRing, NO_RING } = await import("@woco/shared/keyring/ring");
  const g1 = await buildKeyRing({
    parent: PARENT,
    gen: 1,
    prev: NO_RING,
    secret: Uint8Array.from(Buffer.from(S1.slice(2), "hex")),
    prior: [Uint8Array.from(Buffer.from(SEED.slice(2), "hex"))],
    members: [await memberOf(PARENT, A), await memberOf(PARENT, B)],
  });
  // B was taken off the list by another device; C is being added.
  const next = await ringWithMembers({
    parent: PARENT,
    seed: SEED,
    chain,
    current: { ref: chain.ringRef, ring: g1 },
    onChain: [A.address],
    add: [await memberOf(PARENT, C)],
  });
  assert.equal(next.gen, 1);
  assert.equal(next.prev, `0x${chain.ringRef}`);
  assert.deepEqual(next.entries.map((e) => e.statement.coOwner).sort(), [A.address, C.address].sort());
  const c = await opens(next, C);
  assert.equal(hex(c.secret), S1);
  assert.equal(hex(c.prior[0]!), SEED, "the newcomer can read orders from before it joined");
  await assert.rejects(ringWithMembers({ parent: PARENT, seed: SEED, chain: null, current: { ref: chain.ringRef, ring: g1 }, onChain: [A.address], add: [] }), /not the account's current/);
});
