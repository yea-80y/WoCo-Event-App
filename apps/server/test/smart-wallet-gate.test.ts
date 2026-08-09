/**
 * Which authority decides a parent signature (#209).
 *
 * Two verification paths can each accept a delegation, and they do not use the
 * same authority. The second can be satisfied by simulating a deployment that
 * has since been superseded — so once an account is known to have an on-chain
 * owner, that path must not be offered for it at all.
 *
 * The central property is not "the gate returns false". It is that a verifier
 * which WOULD have accepted is never reached. So the delegation tests inject a
 * verifier that unconditionally returns true: if the gate ever leaks, they fail
 * loudly rather than passing for the wrong reason.
 *
 * Split into a pure decision plus an injected seam for the same reason
 * `decideKernelOwnership` is pure — a gate that only exists inline is one whose
 * entire hunk can be reverted with the suite still green.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Wallet, TypedDataEncoder } from "ethers";
import {
  SESSION_DOMAIN,
  SESSION_TYPES,
  SESSION_PURPOSE,
  SESSION_EXPIRY_MS,
} from "@woco/shared";

import { decideSmartWalletPath } from "../src/lib/auth/smart-wallet-gate.js";
import {
  verifyDelegation,
  type DelegationVerifyDeps,
} from "../src/lib/auth/verify-delegation.js";

// ── the pure truth table ─────────────────────────────────────────────────────

test("a remembered account is refused the smart-wallet path, with no chain read", () => {
  const d = decideSmartWalletPath({ knownDeployed: true, liveOwner: "error" });
  assert.equal(d.attempt, false);
});

test("an account whose owner reads live is refused even when unremembered", () => {
  // The window the store alone leaves open: deployed and rotated, but no Path 1
  // verification since, so never marked. That is the freshest instance of the
  // very account this gate exists for.
  const d = decideSmartWalletPath({
    knownDeployed: false,
    liveOwner: "0x1111111111111111111111111111111111111111",
  });
  assert.equal(d.attempt, false);
});

test("an account with provably no owner still gets the smart-wallet path", () => {
  // A Coinbase Smart Wallet holds no storage on the Kernel validator, so it
  // reads as no-owner and must be unaffected.
  const d = decideSmartWalletPath({ knownDeployed: false, liveOwner: null });
  assert.equal(d.attempt, true);
});

test("an unreadable chain does NOT refuse — the store alone decides", () => {
  // Deliberately the opposite polarity to decideKernelOwnership, where an RPC
  // unknown fails closed. There, refusing costs one caller a retry. Here it
  // would cost every smart-wallet user their session on a transient outage.
  const d = decideSmartWalletPath({ knownDeployed: false, liveOwner: "error" });
  assert.equal(d.attempt, true);
});

// ── the gate as wired, with a verifier that would say yes ────────────────────

const PARENT = "0x2222222222222222222222222222222222222222";

const HOST = "gateway.woco-net.com";

/**
 * A delegation naming `parent`, signed by somebody else — so path 1 cannot
 * validate and the gate is what decides the outcome. Message shape mirrors
 * `auth-rejection-codes.test.ts`, which mints exactly as the browser does.
 */
async function delegationFor(parent: string) {
  const session = Wallet.createRandom();
  const nonce = randomUUID();
  const message = {
    host: HOST,
    parent,
    session: session.address,
    purpose: SESSION_PURPOSE,
    nonce,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_EXPIRY_MS).toISOString(),
    sessionProof: await session.signMessage(`${HOST}:${nonce}`),
    clientCodeHash: "0x" + "00".repeat(32),
    statement: `Authorize ${session.address} as session key for ${HOST}`,
  };
  const parentSig = await Wallet.createRandom().signTypedData(
    SESSION_DOMAIN,
    SESSION_TYPES as unknown as Parameters<typeof TypedDataEncoder.hash>[1],
    message,
  );
  return { delegation: { message, parentSig }, session: session.address };
}

function deps(over: Partial<DelegationVerifyDeps> = {}): DelegationVerifyDeps & { calls: number } {
  const state = {
    calls: 0,
    isKernelKnownDeployed: () => false,
    readKernelOwner: async () => null as string | null | "error",
    // Would accept ANYTHING. If the gate leaks, these tests pass wrongly — which
    // is the point: they can only pass for the right reason.
    verifySmartWalletTypedData: async () => {
      state.calls++;
      return true;
    },
    ...over,
  };
  return state as DelegationVerifyDeps & { calls: number };
}

test("a remembered account is refused even by a verifier that accepts everything", async () => {
  const { delegation, session } = await delegationFor(PARENT);
  const d = deps({ isKernelKnownDeployed: () => true });

  const res = await verifyDelegation(delegation as never, session, ["gateway.woco-net.com"], d);

  assert.equal(res.valid, false);
  assert.equal(d.calls, 0, "the smart-wallet verifier must never be reached for a gated account");
});

test("an account whose owner reads live is refused the same way", async () => {
  const { delegation, session } = await delegationFor(PARENT);
  const d = deps({
    isKernelKnownDeployed: () => false,
    readKernelOwner: async () => "0x3333333333333333333333333333333333333333",
  });

  const res = await verifyDelegation(delegation as never, session, ["gateway.woco-net.com"], d);

  assert.equal(res.valid, false);
  assert.equal(d.calls, 0, "a live owner read must gate the path just as the store does");
});

test("an unremembered account with no owner still reaches the verifier", async () => {
  // The CSW case. This is the test that fails if the gate is made too strict.
  const { delegation, session } = await delegationFor(PARENT);
  const d = deps();

  const res = await verifyDelegation(delegation as never, session, ["gateway.woco-net.com"], d);

  assert.equal(d.calls, 1, "a smart wallet must still be offered the path");
  assert.equal(res.valid, true);
});

test("an unreadable chain leaves the path open rather than bricking sessions", async () => {
  const { delegation, session } = await delegationFor(PARENT);
  const d = deps({ readKernelOwner: async () => "error" });

  const res = await verifyDelegation(delegation as never, session, ["gateway.woco-net.com"], d);

  assert.equal(d.calls, 1);
  assert.equal(res.valid, true);
});
