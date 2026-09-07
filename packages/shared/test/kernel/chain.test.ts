/**
 * The Kernel and the names it owns must live on ONE chain (#489).
 *
 * They deliberately did not, for a while: names moved to Arbitrum One first,
 * and `KERNEL_CHAIN_ID` stayed on Arb Sepolia because moving a Kernel is a
 * ZeroDev project + paymaster change rather than a constant. That split was
 * survivable only because the mint rail ran server-side, on the names' chain.
 *
 * It stops being survivable the moment a HOLDER has to prove control of a name
 * from their own account. `releaseRails` (PR D) gates a name release on the
 * holder's signature, and a smart account's signature is an ERC-1271 answer
 * from a contract — which exists on exactly one chain. Ask the registry's chain
 * about a Kernel that lives elsewhere and the answer is "no code at that
 * address": the holder is refused release of a name they plainly own, with an
 * error that reads like a bug in the signature rather than a chain mismatch.
 *
 * So this is not a tidiness assertion. It is the precondition the release rail
 * is built on, and a chain move that broke it would break that rail silently.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { KERNEL_CHAIN_ID } from "../../src/kernel/chain.js";
import { SUB_ENS_DEFAULT_CHAIN_ID, SUB_ENS_DEPLOYMENTS } from "../../src/sub-ens/addresses.js";

test("the Kernel runs on the chain the names live on", () => {
  assert.equal(
    KERNEL_CHAIN_ID,
    SUB_ENS_DEFAULT_CHAIN_ID,
    "a Kernel holder cannot answer ERC-1271 on a chain its account is not deployed to",
  );
});

test("that chain is a real sub-ENS deployment, not just a matching number", () => {
  const d = SUB_ENS_DEPLOYMENTS[KERNEL_CHAIN_ID];
  assert.ok(d?.registrar, "no registrar deployed on the Kernel chain");
  assert.ok(d?.registry, "no registry deployed on the Kernel chain");
});
