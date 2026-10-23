/**
 * The shared address map against the contracts actually deployed on Arbitrum
 * One (registry v2.2, the launch deploy of 2026-10-23).
 *
 * The browser signs against `SUB_ENS_DEPLOYMENTS[42161]` directly — the
 * registrar is the `verifyingContract` of every `SetContenthash`, the registry
 * of every `Release` — and has no env to override it the way the server does.
 * After the v2.2 deploy the map still named the retired v1 pair while every
 * suite stayed green, because the other typed-data vectors use a made-up
 * registrar address. A stale row is a signature for a contract that refuses it.
 *
 * The two digests below were READ FROM THE LIVE CONTRACTS on 2026-10-23
 * (`setContenthashDigest` on the registrar, `releaseDigest` on the registry,
 * base name `woco.eth`, pointerNonce 0, recordVersion 1) and matched the
 * browser's own builders fed from this map. If either side moves — an address,
 * the domain, the struct — this fails a build instead of a holder's bind.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TypedDataEncoder, namehash } from "ethers";
import { SUB_ENS_DEPLOYMENTS } from "@woco/shared";
import { buildPointerTypedData, swarmContenthash } from "../src/lib/sub-ens/pointer-digest.js";
import { buildReleaseTypedData } from "../src/lib/sub-ens/release-digest.js";

const MAINNET = SUB_ENS_DEPLOYMENTS[42161];
const BASE_NODE = namehash("woco.eth") as `0x${string}`;
const EXPIRATION = 1_790_100_000;

test("the map names the v2.2 pair the L1 resolver points at", () => {
  assert.equal(MAINNET.registry, "0x00d0054Ca80d97014947CE97d58402EbED0946EE");
  assert.equal(MAINNET.registrar, "0x2812A3F1Fe35C85a953248152eF41EeD5Dc9c12A");
});

test("SetContenthash from the map hashes to the live registrar's digest", () => {
  const { domain, types, message } = buildPointerTypedData({
    registrar: MAINNET.registrar,
    chainId: 42161,
    name: "woco.eth",
    node: BASE_NODE,
    contenthash: swarmContenthash("d66c6ff7650a468c2fd98439c8f04547b5b8a4b933d349ff16db1d0b00c23adc"),
    nonce: 0n,
    expiration: EXPIRATION,
  });
  assert.equal(
    TypedDataEncoder.hash(domain, types, message),
    "0x2f4830f869446b616f18b67afcab3f6324833b0349aa0b29a4f172aaecfa7b9a",
  );
});

test("Release from the map hashes to the live registry's digest", () => {
  const { domain, types, message } = buildReleaseTypedData({
    registry: MAINNET.registry,
    chainId: 42161,
    name: "woco.eth",
    node: BASE_NODE,
    recordVersion: 1n,
    expiration: EXPIRATION,
  });
  assert.equal(
    TypedDataEncoder.hash(domain, types, message),
    "0xd4dab5e5d05b8dce489853e2a56252b7fb352a19343548990c9e83ce35831db0",
  );
});
