/**
 * A revoked session is refused as SESSION_REVOKED, not SESSION_INVALID (#186).
 * The client answers SESSION_INVALID by minting a new delegation, which a
 * passkey or email login does silently - so "Sign out everywhere" was undone on
 * every such device by its next request. SESSION_REVOKED makes it sign out.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypedDataEncoder, Wallet } from "ethers";
import {
  AuthErrorCode,
  SESSION_DOMAIN,
  SESSION_EXPIRY_MS,
  SESSION_PURPOSE,
  SESSION_TYPES,
} from "@woco/shared";

const HOST = "test.woco.local";
const dir = mkdtempSync(join(tmpdir(), "woco-session-revoked-"));
const originalCwd = process.cwd();
process.chdir(dir);
mkdirSync(join(dir, ".data"));
after(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

const { verifyDelegation } = await import("../src/lib/auth/verify-delegation.js");
const { revokeAllSessions, revokeSession } = await import("../src/lib/auth/revocation.js");

async function mint(issuedAgoMs = 1000) {
  const parent = Wallet.createRandom();
  const session = Wallet.createRandom();
  const nonce = randomUUID();
  const issuedAt = Date.now() - issuedAgoMs;
  const message = {
    host: HOST,
    parent: parent.address,
    session: session.address,
    purpose: SESSION_PURPOSE,
    nonce,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(issuedAt + SESSION_EXPIRY_MS).toISOString(),
    sessionProof: await session.signMessage(`${HOST}:${nonce}`),
    clientCodeHash: "0x" + "00".repeat(32),
    statement: `Authorize ${session.address} as session key for ${HOST}`,
  };
  const parentSig = await parent.signTypedData(
    SESSION_DOMAIN,
    SESSION_TYPES as unknown as Parameters<typeof TypedDataEncoder.hash>[1],
    message,
  );
  return { parent, session, delegation: { message, parentSig } };
}

test("a session issued before 'Sign out everywhere' is SESSION_REVOKED", async () => {
  const d = await mint();
  assert.equal((await verifyDelegation(d.delegation, d.session.address, [HOST])).valid, true);
  revokeAllSessions(d.parent.address);
  const r = await verifyDelegation(d.delegation, d.session.address, [HOST]);
  assert.equal(r.valid, false);
  assert.equal(r.code, AuthErrorCode.SESSION_REVOKED);
});

test("a single revoked session is SESSION_REVOKED too", async () => {
  const d = await mint();
  revokeSession(d.delegation.message.nonce, d.delegation.message.expiresAt);
  const r = await verifyDelegation(d.delegation, d.session.address, [HOST]);
  assert.equal(r.code, AuthErrorCode.SESSION_REVOKED);
});
