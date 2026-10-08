/**
 * Server half of the wallet-login flag (#186).
 *
 * A wallet account's identity seed is one fixed signature any site can ask for, so
 * wallet login is off for launch. The client hides it and refuses it; this is the
 * half that holds for an old bundle (a published event page keeps the wallet sign-in
 * it was published with) or a crafted request: a delegation signed by its own
 * parent EOA is refused, and nothing after the refusal is consulted.
 *
 * Kernel (passkey, email) delegations are untouched: device-grants and
 * kernel-co-owners run with this flag OFF.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { randomUUID } from "node:crypto";
import { AuthErrorCode, FEATURES, SESSION_DOMAIN, SESSION_EXPIRY_MS, SESSION_PURPOSE, SESSION_TYPES } from "@woco/shared";
import { verifyDelegation } from "../src/lib/auth/verify-delegation.js";

const HOST = "localhost:5173";

async function walletDelegation() {
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
  const parentSig = await parent.signTypedData(SESSION_DOMAIN, SESSION_TYPES as never, message);
  return { session, delegation: { message, parentSig } };
}

test("the flag is off for launch - these tests pin the OFF behaviour", () => {
  assert.equal(FEATURES.walletLoginAllowed as boolean, false);
});

test("a delegation signed by its own parent EOA is refused, and nothing else is consulted", async () => {
  const { session, delegation } = await walletDelegation();
  const calls = { grant: 0, verify: 0, ownerReads: 0 };
  const result = await verifyDelegation(delegation as never, session.address, [HOST], {
    lookupDeviceGrant: async () => {
      calls.grant++;
      return undefined;
    },
    isKernelKnownDeployedOnAnyChain: () => false,
    readKernelOwner: async () => {
      calls.ownerReads++;
      return null;
    },
    verifySmartWalletTypedData: async () => {
      calls.verify++;
      return true;
    },
  });
  assert.equal(result.valid, false);
  assert.equal(result.code, AuthErrorCode.SESSION_INVALID);
  assert.deepEqual(calls, { grant: 0, verify: 0, ownerReads: 0 });
});
