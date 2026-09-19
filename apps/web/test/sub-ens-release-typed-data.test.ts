/**
 * What a holder signs to release a name (registry v2.1, WoCo-Contracts #21).
 *
 * The typed data is built here and its hash is checked against the chain's
 * `releaseDigest` before any wallet sees it. The vector below is pinned in the
 * contract's own suite too (`SubEnsV21AuditRegression.t.sol`,
 * `test_712_ThePinnedVector`), against a registry at the same address on the
 * same chain — so a drift on either side fails a build, not a holder's release.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TypedDataEncoder, namehash } from "ethers";
import {
  RELEASE_DIGEST_ABI,
  RELEASE_TTL_SECS,
  buildReleaseTypedData,
  releaseExpiration,
} from "../src/lib/sub-ens/release-digest.js";
import { unroutableReleaseRefusal } from "../src/lib/sub-ens/errors.js";

const VECTOR = {
  registry: "0x1234567890123456789012345678901234567890",
  chainId: 42161,
  name: "alice.woco.eth",
  node: namehash("alice.woco.eth"),
  recordVersion: 1n,
  expiration: 1_800_000_600,
  digest: "0xcea241832188eef27baf500e3b8092fef292cac6e8f0cc049747e5c1ba5ba82a",
} as const;

function typed() {
  return buildReleaseTypedData({
    registry: VECTOR.registry,
    chainId: VECTOR.chainId,
    name: VECTOR.name,
    node: VECTOR.node as `0x${string}`,
    recordVersion: VECTOR.recordVersion,
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
    name: "WoCo Names",
    version: "2",
    chainId: 42161,
    verifyingContract: VECTOR.registry,
  });
  assert.equal(
    TypedDataEncoder.from(types).encodeType("Release"),
    "Release(string name,bytes32 node,uint64 recordVersion,uint256 expiration)",
  );
});

test("every field is load-bearing: changing any one moves the digest", () => {
  const base = typed();
  const variants = [
    { ...base, domain: { ...base.domain, chainId: 421614 } },
    { ...base, domain: { ...base.domain, verifyingContract: "0x1234567890123456789012345678901234567891" } },
    { ...base, domain: { ...base.domain, version: "1" } },
    { ...base, message: { ...base.message, name: "bob.woco.eth" } },
    { ...base, message: { ...base.message, node: namehash("bob.woco.eth") } },
    { ...base, message: { ...base.message, recordVersion: 2n } },
    { ...base, message: { ...base.message, expiration: VECTOR.expiration + 1 } },
  ];
  for (const v of variants) {
    assert.notEqual(TypedDataEncoder.hash(v.domain, v.types, v.message), VECTOR.digest);
  }
});

test("the builder hands out a fresh types object each time", () => {
  // ethers' signTypedData may annotate what it is given; a shared constant
  // would carry that into the next release.
  assert.notEqual(typed().types.Release, typed().types.Release);
});

test("the client reads no typehash: the digest comparison covers it", () => {
  assert.deepEqual([...RELEASE_DIGEST_ABI], [
    "function recordVersions(bytes32 node) view returns (uint64)",
    "function releaseDigest(bytes32 node, uint256 expiration) view returns (bytes32)",
  ]);
});

test("the expiration stays far inside the registry's 48-hour ceiling", () => {
  assert.equal(RELEASE_TTL_SECS, 600);
  assert.equal(releaseExpiration(1_000_000), 1000 + 600);
});

test("a name with names beneath it is shown, never routed round", () => {
  assert.match(unroutableReleaseRefusal("has_children") ?? "", /names beneath it/);
  assert.match(unroutableReleaseRefusal("profile_name") ?? "", /profile is known by/);
  for (const code of ["signature_not_authorised", "expiration_too_far", "rate_limited", undefined]) {
    assert.equal(unroutableReleaseRefusal(code), null, `${code} should fall back to the holder's own rail`);
  }
});

function sourceOf(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf-8");
}

test("the discard dialog signs typed data as the holder, never a personal message", () => {
  const dialog = sourceOf("../src/lib/creator/builder/DiscardNameDialog.svelte");
  const script = dialog.slice(dialog.indexOf("<script"), dialog.indexOf("</script>"));
  assert.doesNotMatch(script, /signMessage\(/, "a personal-sign signature is not a v2.1 release");
  assert.match(script, /signTypedData: \(typed: ReleaseTypedData\) => auth\.signTypedDataAsHolder\(typed\)/);
});

test("the holder signer puts a wallet on the domain's chain first, and refuses Coinbase", () => {
  const store = sourceOf("../src/lib/auth/auth-store.svelte.ts");
  const start = store.indexOf("async function signTypedDataAsHolder(");
  const body = store.slice(start, store.indexOf("\n}\n", start));
  assert.ok(start > 0, "signTypedDataAsHolder not found");
  assert.doesNotMatch(body, /signMessage\(/);
  // web3: the typed data's own chain, switched to BEFORE the wallet signs.
  const web3 = body.slice(body.indexOf('if (_kind === "web3")'), body.indexOf('if (_kind === "passkey"'));
  const sw = web3.indexOf("await switchChain(typed.domain.chainId");
  const sign = web3.indexOf(".signTypedData(");
  assert.ok(sw > 0 && sign > sw, "the wallet must be on the domain's chain before it signs");
  // Kernel kinds sign as the Kernel (the holder), never as the raw owner key.
  assert.match(body, /createKernelTypedDataSigner\(_kernel\.account\)/);
  assert.doesNotMatch(body, /_passkeyPrivateKey|_web3authPrivateKey|createLocalSigner/);
  // Coinbase falls through to the refusal: no branch may sign for it.
  assert.doesNotMatch(body, /_kind === "coinbase"/, "a CSW signature can never verify on the names' chain");
  assert.match(body, /throw new Error\("Signing for a name isn't available for this sign-in method yet/);
});

test("the release uses the chain's digest as the reference, and refuses on a mismatch", () => {
  const release = sourceOf("../src/lib/sub-ens/release.ts");
  assert.match(release, /TypedDataEncoder\.hash\(typedData\.domain, typedData\.types, typedData\.message\)/);
  assert.match(release, /if \(local\.toLowerCase\(\) !== onChainDigest\.toLowerCase\(\)\) \{\s*throw new Error/);
  assert.match(release, /const shown = unroutableReleaseRefusal\(relayed\.error\);\s*if \(shown\) throw new Error\(shown\);/);
});

test("the expiration is taken from the registry chain's latest block, never this device's clock (audit 950 Low 13)", () => {
  const src = readFileSync(new URL("../src/lib/sub-ens/release.ts", import.meta.url), "utf-8");
  const prepare = src.slice(src.indexOf("export async function prepareRelease"), src.indexOf("export interface ReleaseResult"));
  assert.match(prepare, /provider\.getBlock\("latest"\)/);
  assert.match(prepare, /releaseExpiration\(latest\.timestamp \* 1000\)/);
  assert.doesNotMatch(prepare, /Date\.now\(\)/);
  // No default either: a caller that forgets the chain time does not compile.
  const digest = readFileSync(new URL("../src/lib/sub-ens/release-digest.ts", import.meta.url), "utf-8");
  assert.match(digest, /export function releaseExpiration\(chainNowMs: number\): number/);
});
