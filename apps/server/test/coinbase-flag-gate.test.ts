/**
 * Server half of the Coinbase Smart Wallet flag (#173).
 *
 * The property pinned is the same one the #209 gate tests pin: a verifier
 * that WOULD accept is never reached. While `coinbaseLoginAllowed` is off,
 * the ERC-1271/6492 fallback in verifyDelegation has no intended client, so
 * a smart-wallet-shaped delegation must be refused BEFORE any chain read —
 * otherwise the flag is a missing button, not a closed rail, and an old
 * client (or a crafted request) authenticates straight past it.
 *
 * If this file starts failing because the flag was flipped ON, that is the
 * test doing its job: re-check that the CSW escrow path (#164) landed, then
 * update these expectations deliberately.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { randomUUID } from "node:crypto";
import { AuthErrorCode, FEATURES, SESSION_PURPOSE, SESSION_EXPIRY_MS } from "@woco/shared";
import { verifyDelegation } from "../src/lib/auth/verify-delegation.js";

const HOST = "localhost:5173";

/** A delegation whose parent is a smart account: the signature is NOT a
 *  65-byte ecrecover-able sig, so only the 1271/6492 path could accept it. */
async function mintSmartWalletShapedDelegation() {
  const session = Wallet.createRandom();
  const smartAccount = Wallet.createRandom().address; // the claimed CSW parent
  const nonce = randomUUID();
  const message = {
    host: HOST,
    parent: smartAccount,
    session: session.address,
    purpose: SESSION_PURPOSE,
    nonce,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_EXPIRY_MS).toISOString(),
    sessionProof: await session.signMessage(`${HOST}:${nonce}`),
    clientCodeHash: "0x" + "00".repeat(32),
    statement: `Authorize ${session.address} as session key for ${HOST}`,
  };
  // 6492-wrapped signatures are long opaque blobs — anything non-65-byte
  // routes past ecrecover and into the smart-wallet path.
  const parentSig = "0x" + "ab".repeat(300);
  return { session, delegation: { message, parentSig } };
}

test("flag documents itself off — these tests pin the OFF behaviour", () => {
  assert.equal(FEATURES.coinbaseLoginAllowed as boolean, false);
});

test("a smart-wallet delegation is refused, and the would-accept verifier is never consulted", async () => {
  const { session, delegation } = await mintSmartWalletShapedDelegation();
  const calls = { verify: 0, ownerReads: 0, deployedChecks: 0 };

  const result = await verifyDelegation(delegation as never, session.address, [HOST], {
    isKernelKnownDeployed: () => {
      calls.deployedChecks++;
      return false;
    },
    readKernelOwner: async () => {
      calls.ownerReads++;
      return null;
    },
    verifySmartWalletTypedData: async () => {
      calls.verify++;
      return true; // WOULD accept — reaching this is the failure being pinned
    },
  });

  assert.equal(result.valid, false);
  assert.equal(result.code, AuthErrorCode.SESSION_INVALID);
  assert.equal(calls.verify, 0, "1271/6492 verifier must not be consulted while the flag is off");
  // Refused before any chain authority is consulted — the gate is the flag,
  // not the account's deployment state.
  assert.equal(calls.ownerReads, 0);
  assert.equal(calls.deployedChecks, 0);
});

test("the EOA / Kernel-owner ecrecover path is untouched by the flag", async () => {
  // A plain-EOA delegation (65-byte sig, recovered == parent) must still
  // verify: the flag closes the smart-wallet fallback, not path (a)/(b).
  const parent = Wallet.createRandom();
  const session = Wallet.createRandom();
  const nonce = randomUUID();
  const message = {
    host: HOST,
    parent: parent.address,
    session: session.address,
    purpose: SESSION_PURPOSE,
    nonce,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_EXPIRY_MS).toISOString(),
    sessionProof: await session.signMessage(`${HOST}:${nonce}`),
    clientCodeHash: "0x" + "00".repeat(32),
    statement: `Authorize ${session.address} as session key for ${HOST}`,
  };
  const { SESSION_DOMAIN, SESSION_TYPES } = await import("@woco/shared");
  const parentSig = await parent.signTypedData(
    SESSION_DOMAIN,
    SESSION_TYPES as never,
    message,
  );

  const result = await verifyDelegation({ message, parentSig } as never, session.address, [HOST], {
    isKernelKnownDeployed: () => false,
    readKernelOwner: async () => null,
    verifySmartWalletTypedData: async () => {
      throw new Error("must not be reached for an ecrecover-able delegation");
    },
  });

  assert.equal(result.valid, true, result.error);
});
