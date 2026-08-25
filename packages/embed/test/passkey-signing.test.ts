/**
 * The embed's passkey claim signature, pinned to exact bytes.
 *
 * `signClaimDigest` produces the `signature` field of a passkey claim. A
 * verifier recovers an address from it and treats that address as the claimer,
 * so three things have to hold at once and only the first fails loudly.
 *
 * No server does that today — the route this posts to died with the v1 rail
 * (#207), so the claim buttons reach a 404 (#206). These vectors therefore pin
 * the format against ethers rather than against a live endpoint, which is the
 * stronger thing to pin anyway: they will still be right when the v2 rail
 * (#202) arrives, and they would catch a v3 @noble change in the meantime.
 *
 *   1. the call must not throw — @noble/curves v2 returns encoded BYTES where v1
 *      returned an object with `.r`/`.s`/`.recovery`, so the old code threw on
 *      every call and the claim path was dead for three weeks (#143);
 *   2. the signature must be over the digest AS GIVEN — v2's `prehash` defaults
 *      to true, which would sign sha256(digest) instead. That produces a
 *      perfectly valid signature over the wrong bytes, and the only symptom is
 *      the server recovering a stranger's address;
 *   3. `v` must be right, or recovery yields a different address.
 *
 * The vectors are FROZEN: computed once from `ethers.SigningKey.sign`, the
 * implementation the server verifies with, and hardcoded here. That is
 * deliberate — a test that recomputed the expectation from another library at
 * run time would follow that library through its own future changes, and the
 * point is to notice when our output moves. Two vectors carry v=27 and two v=28,
 * so the recovery byte is exercised in both directions.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

import { signClaimDigest, getAddress } from "../src/auth/passkey.js";

const bytes = (hex: string): Uint8Array => {
  const h = hex.replace(/^0x/, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** Frozen: produced by `new ethers.SigningKey(pk).sign(digest)`. */
const VECTORS = [
  {
    pk: "0x0827466584a3c2e1001f3e5d7c9bbad9f81736557493b2d1f00f2e4d6c8baac9",
    digest: "0x102132435465768798a9bacbdcedfe0f2031425364758697a8b9cadbecfd0e1f",
    sig: "0xd0b1414ff8488ad636beec5cc8b54a443ecb39f653a5ff4b9dcc9e139391a9d9027d6ce8a3f6675040475ed1682c35b49c63a7fe8c365fce5e52a327e42d4a001b",
    addr: "0xd08e15058e4f69551d9854f64848c9f99fd382bb",
  },
  {
    pk: "0x0f2e4d6c8baac9e80726456483a2c1e0ff1e3d5c7b9ab9d8f71635547392b1d0",
    digest: "0x1d2e3f5061728394a5b6c7d8e9fa0b1c2d3e4f60718293a4b5c6d7e8f90a1b2c",
    sig: "0xbe929f7239bcfde900ec488b8de5f7b568dabeb093547083044b6f03870ea92b34dc94007473ce328faded6a22b452acb3447441fd0b70784dff7c570c12d0ac1b",
    addr: "0xe6f0e3eab733e6f3dc793b792779f454226d82ee",
  },
  {
    pk: "0x1635547392b1d0ef0e2d4c6b8aa9c8e70625446382a1c0dffe1d3c5b7a99b8d7",
    digest: "0x2a3b4c5d6e7f90a1b2c3d4e5f60718293a4b5c6d7e8fa0b1c2d3e4f506172839",
    sig: "0x15508a65ccf9ae26b8f0471ccc4fe660ef9b6951d49ce61d9c1b4ffb7e46f1623f67dd5514852a05b5ec62e2814e34aeabb7b11d0ae119eec81b3251e07a0e051c",
    addr: "0x567b2cb0d9350f13bf0999f1869d0556ed78fcc7",
  },
  {
    pk: "0x27466584a3c2e1001f3e5d7c9bbad9f81736557493b2d1f00f2e4d6c8baac9e8",
    digest: "0x25364758697a8b9cadbecfe0f102132435465768798a9bacbdcedff001122334",
    sig: "0x93e0c24ceb95254168a2bae019335f7270ceeac962547f38c1df3a9ec65c170d2cb849cbbfb43f5b3916f6df4112ed1b92ad7accbc24d5593de4c928727a620f1c",
    addr: "0x77bd828a22dd609330d21057e55c55127c4b0cff",
  },
];

test("the signature matches ethers byte for byte, for both recovery values", () => {
  for (const v of VECTORS) {
    assert.equal(signClaimDigest(bytes(v.pk), bytes(v.digest)), v.sig, `vector ${v.addr}`);
  }
  // Non-vacuity: the four vectors must not all carry the same v, or a wrong
  // recovery byte would pass half the time and the suite would still be green.
  const vs = new Set(VECTORS.map((v) => v.sig.slice(-2)));
  assert.deepEqual([...vs].sort(), ["1b", "1c"]);
});

test("the address derivation matches ethers too", () => {
  // getAddress reads `secp256k1.getPublicKey`, which is the same v2 API surface
  // that moved under signClaimDigest. It is what names the claimer, so it is
  // pinned rather than assumed to have survived.
  for (const v of VECTORS) {
    assert.equal(getAddress(bytes(v.pk)), v.addr, `address for ${v.addr}`);
  }
});

test("recovery returns the signer, which is what the server does with this", () => {
  // Independent of the frozen bytes: recover the public key from what we
  // produced and check it names the same account. This is the property the
  // server relies on, expressed without ethers.
  for (const v of VECTORS) {
    const sig = bytes(v.sig);
    const recovery = sig[64]! - 27;
    const recoverable = new Uint8Array(65);
    recoverable[0] = recovery;
    recoverable.set(sig.subarray(0, 64), 1);

    const pub = secp256k1.recoverPublicKey(recoverable, bytes(v.digest), { prehash: false });
    const uncompressed = secp256k1.Point.fromBytes(pub).toBytes(false);
    const addr = "0x" + Buffer.from(keccak_256(uncompressed.slice(1)).slice(12)).toString("hex");
    assert.equal(addr, v.addr);
  }
});

test("the digest is signed as given, never re-hashed", () => {
  // The silent failure this guards. If `prehash` were left at its v2 default the
  // call would still succeed and still return 65 well-formed bytes — it would
  // just be a signature over sha256(digest), and the server would recover a
  // stranger. Asserting the two differ is what makes that visible.
  const v = VECTORS[0]!;
  const rehashed = secp256k1.sign(bytes(v.digest), bytes(v.pk), { format: "recovered" });
  const asGiven = secp256k1.sign(bytes(v.digest), bytes(v.pk), { prehash: false, format: "recovered" });
  assert.notDeepEqual(rehashed, asGiven, "prehash must change the output, or this test proves nothing");
  assert.equal("0x" + Buffer.from(asGiven.subarray(1)).toString("hex") + (asGiven[0]! + 27).toString(16), v.sig);
});

test("a digest that is not 32 bytes is refused", () => {
  assert.throws(() => signClaimDigest(bytes(VECTORS[0]!.pk), new Uint8Array(31)), /32 bytes/);
});
