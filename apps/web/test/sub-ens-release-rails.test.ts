/**
 * Who may burn a name today, and why the answer is a chain comparison (#484).
 *
 * `L2Registry.releaseWithSignature` checks the holder's signature through the
 * ERC-6492 universal validator: with no code at the holder's address it falls
 * back to `ecrecover`, so only a plain EOA holder can be authorised. Every
 * other login kind holds its names through a SMART ACCOUNT — the Kernel for
 * passkey AND web3auth (`auth-store.svelte.ts`: "The Kernel address (not the
 * EOA) becomes the parent identity"), a Coinbase Smart Wallet for coinbase —
 * and a contract can only answer ERC-1271 on a chain where it exists.
 *
 * So the gate is `kernelChainId === nameChainId`, and it must stay a comparison
 * rather than a flag: #489 moves the account to Arbitrum One and the discard
 * button has to switch itself on, with nobody remembering to flip anything.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseRails } from "../src/lib/sub-ens/release-rails.js";

const NAME_CHAIN = 42161;      // SUB_ENS_DEFAULT_CHAIN_ID
const KERNEL_TODAY = 421614;   // KERNEL_CHAIN_ID before #489
const AA_KINDS = ["passkey", "coinbase", "web3auth"] as const;

test("a wallet login can always discard: relay first, own gas behind it", () => {
  for (const kernelChain of [KERNEL_TODAY, NAME_CHAIN]) {
    const plan = releaseRails("web3", kernelChain, NAME_CHAIN);
    assert.equal(plan.available, true);
    assert.deepEqual(plan.rails, ["relay", "wallet"]);
    assert.equal(plan.reason, undefined);
  }
});

test("smart-account logins are refused while the account is on another chain", () => {
  for (const kind of AA_KINDS) {
    const plan = releaseRails(kind, KERNEL_TODAY, NAME_CHAIN);
    assert.equal(plan.available, false, `${kind} must not be offered today`);
    assert.deepEqual(plan.rails, []);
    assert.match(plan.reason ?? "", /Arbitrum One account move/);
    // The copy must not read as loss — the name is untouched.
    assert.match(plan.reason ?? "", /stays yours/);
  }
});

test("the same logins switch on by themselves once the chains agree (#489)", () => {
  for (const kind of AA_KINDS) {
    const plan = releaseRails(kind, NAME_CHAIN, NAME_CHAIN);
    assert.equal(plan.available, true, `${kind} must be offered after the move`);
    assert.deepEqual(plan.rails, ["relay", "kernel"]);
    // No wallet rail: a smart account has no EOA to pay from.
    assert.equal(plan.rails.includes("wallet"), false);
  }
});

test("web3auth is an AA kind — its parent is the Kernel, not the Web3Auth EOA", () => {
  // Pinned on its own because the step-9 design filed web3auth with web3 as an
  // "EOA login". If someone restores that, this fails rather than shipping a
  // discard button that reverts Unauthorized on every use.
  assert.equal(releaseRails("web3auth", KERNEL_TODAY, NAME_CHAIN).available, false);
});

test("signed-out and unimplemented kinds are refused with a reason, never a crash", () => {
  const out = releaseRails("none", KERNEL_TODAY, NAME_CHAIN);
  assert.equal(out.available, false);
  assert.match(out.reason ?? "", /Sign in/);

  const zupass = releaseRails("zupass", NAME_CHAIN, NAME_CHAIN);
  assert.equal(zupass.available, false);
  assert.deepEqual(zupass.rails, []);
});
