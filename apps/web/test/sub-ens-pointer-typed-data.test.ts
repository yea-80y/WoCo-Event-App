/**
 * What a holder signs to point a name (registrar v2.2, Fable sponsor-key
 * consult §2.1).
 *
 * The typed data is built here and its hash is checked against the chain's
 * `setContenthashDigest` before any wallet sees it. The vector below is pinned
 * in the contract's own suite too (`WoCoRegistrarSignedPointer.t.sol`,
 * `test_712_ThePinnedVector`), against a registrar at the same address on the
 * same chain — so a drift on either side fails a build, not a holder's bind.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TypedDataEncoder, namehash } from "ethers";
import {
  POINTER_TTL_SECS,
  buildPointerTypedData,
  swarmContenthash,
} from "../src/lib/sub-ens/pointer-digest.js";

const H1_REF = "11".repeat(32);
const VECTOR = {
  registrar: "0x2222222222222222222222222222222222222222",
  chainId: 42161,
  name: "alice.woco.eth",
  node: namehash("alice.woco.eth"),
  contenthash: `0xe40101fa011b20${H1_REF}`,
  nonce: 0n,
  expiration: 1_800_000_600,
  digest: "0xef298aebfab76e89d2bc72bf1bbbecf149cee2142b1e44bafcd04fe04607a085",
} as const;

function typed() {
  return buildPointerTypedData({
    registrar: VECTOR.registrar,
    chainId: VECTOR.chainId,
    name: VECTOR.name,
    node: VECTOR.node as `0x${string}`,
    contenthash: VECTOR.contenthash,
    nonce: VECTOR.nonce,
    expiration: VECTOR.expiration,
  });
}

test("the typed data hashes to the digest the contract computes", () => {
  const { domain, types, message } = typed();
  assert.equal(TypedDataEncoder.hash(domain, types, message), VECTOR.digest);
});

test("the domain and the struct are exactly the contract's", () => {
  const { domain, types } = typed();
  assert.deepEqual(domain, {
    name: "WoCo Registrar",
    version: "1",
    chainId: 42161,
    verifyingContract: VECTOR.registrar,
  });
  assert.equal(
    TypedDataEncoder.from(types).encodeType("SetContenthash"),
    "SetContenthash(string name,bytes32 node,bytes contenthash,uint256 nonce,uint256 expiration)",
  );
});

test("every field is load-bearing: changing any one moves the digest", () => {
  const base = typed();
  const variants = [
    { ...base, domain: { ...base.domain, chainId: 421614 } },
    { ...base, domain: { ...base.domain, verifyingContract: "0x2222222222222222222222222222222222222223" as const } },
    { ...base, domain: { ...base.domain, name: "WoCo Names" } },
    { ...base, domain: { ...base.domain, version: "2" } },
    { ...base, message: { ...base.message, name: "bob.woco.eth" } },
    { ...base, message: { ...base.message, node: namehash("bob.woco.eth") as `0x${string}` } },
    { ...base, message: { ...base.message, contenthash: `0xe40101fa011b20${"22".repeat(32)}` as const } },
    { ...base, message: { ...base.message, nonce: 1n } },
    { ...base, message: { ...base.message, expiration: VECTOR.expiration + 1 } },
  ];
  for (const v of variants) {
    assert.notEqual(TypedDataEncoder.hash(v.domain, v.types, v.message), VECTOR.digest);
  }
});

test("the builder hands out a fresh types object each time", () => {
  const a = typed();
  const b = typed();
  assert.notEqual(a.types.SetContenthash, b.types.SetContenthash);
  a.types.SetContenthash.push({ name: "x", type: "uint256" });
  assert.equal(b.types.SetContenthash.length, 5);
});

test("a Swarm reference encodes as the EIP-1577 contenthash the registry stores", () => {
  assert.equal(swarmContenthash(H1_REF), VECTOR.contenthash);
  assert.equal(swarmContenthash(`0x${H1_REF.toUpperCase()}`), VECTOR.contenthash, "0x and casing normalised");
  for (const bad of ["", "11", `${H1_REF}00`, "zz".repeat(32)]) {
    assert.throws(() => swarmContenthash(bad), /Nothing was signed/);
  }
});

test("the signature's lifetime sits inside the relay's window on the chain's clock", () => {
  // The relay refuses anything outside 60 s – 15 min of the latest block.
  assert.ok(POINTER_TTL_SECS > 60 && POINTER_TTL_SECS < 15 * 60);
  const src = readFileSync(new URL("../src/lib/sub-ens/pointer.ts", import.meta.url), "utf-8");
  assert.match(src, /const expiration = latest\.timestamp \+ POINTER_TTL_SECS;/);
  assert.doesNotMatch(src, /Date\.now\(\)/, "never this device's clock (audit 950 Low 13)");
});

test("the app refuses to sign when its digest and the registrar's disagree", () => {
  const src = readFileSync(new URL("../src/lib/sub-ens/pointer.ts", import.meta.url), "utf-8");
  const prepare = src.slice(src.indexOf("export async function preparePointer"), src.indexOf("export async function pointNameAt"));
  assert.match(prepare, /registrar\.setContenthashDigest\(node, contenthash, expiration\)/);
  assert.match(prepare, /if \(local\.toLowerCase\(\) !== onChainDigest\.toLowerCase\(\)\) \{\s*throw/);
  // …and the relay is handed exactly the expiration that was signed.
  const point = src.slice(src.indexOf("export async function pointNameAt"));
  const sign = point.indexOf("await signTypedData(typed)");
  const post = point.indexOf('"/api/sub-ens/set-contenthash"');
  assert.ok(point.indexOf("await preparePointer(") < sign && sign < post);
  assert.match(point, /expiration: typed\.message\.expiration,/);
});
