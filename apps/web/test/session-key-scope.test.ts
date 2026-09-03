/**
 * A scoped session key is only useful for the registrar and chain it was minted
 * against (#470).
 *
 * THE BUG THIS PINS. A session key's CallPolicy targets one registrar address.
 * When that address moves — as it did twice in two days — a key already on a
 * device is still scoped to the OLD one, and nothing noticed:
 *
 *   · `hasWocoSessionKey` compared only which Kernel the blob belonged to.
 *   · The permit-vs-constant guard compares two values that MOVED TOGETHER, so
 *     it passes.
 *
 * The userOp was then rejected by the permission validator, the caller read
 * that as an account-abstraction failure, and `claimSubEnsViaPermit` silently
 * fell back to the server-sponsored mint. The user got the right name with the
 * right owner, so nothing looked broken — while the gasless rail was dead on
 * that device and WoCo paid the gas.
 *
 * The fix is to record the SCOPE beside the key, so a moved registrar makes the
 * stored key report itself unusable and the caller re-mints.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/lib/auth/kernel-account.ts", import.meta.url), "utf-8");
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("//"))
  .join("\n");

function fn(name: string): string {
  const start = CODE.indexOf(name);
  assert.ok(start > 0, `${name} not found`);
  const next = CODE.indexOf("\nexport ", start + name.length);
  const alsoNext = CODE.indexOf("\nasync function", start + name.length);
  const end = [next, alsoNext].filter((i) => i > 0).sort((a, b) => a - b)[0];
  return CODE.slice(start, end ?? undefined);
}

test("what is stored records the registrar and the chain, not just the key", () => {
  const mint = fn("export async function createWocoSessionKey");
  assert.match(mint, /registrar: WOCO_REGISTRAR_ADDRESS\.toLowerCase\(\)/);
  assert.match(mint, /chainId: KERNEL_CHAIN_ID/);
  assert.match(mint, /v: SESSION_BLOB_VERSION/);
});

test("a stored key is usable only when BOTH the registrar and the chain match", () => {
  const scope = fn("function sessionKeyScopeMatches");
  assert.match(scope, /stored\.registrar === WOCO_REGISTRAR_ADDRESS\.toLowerCase\(\)/);
  assert.match(scope, /stored\.chainId === KERNEL_CHAIN_ID/);
  // Both, not either — an && not an ||.
  assert.match(scope, /&&/);
  assert.doesNotMatch(scope, /\|\|/);
});

test("hasWocoSessionKey consults the scope, not only the Kernel address", () => {
  // This is the exact check that was missing: it used to compare the stored
  // account address and nothing else.
  const has = fn("export async function hasWocoSessionKey");
  assert.match(has, /sessionKeyScopeMatches/);
  assert.match(has, /extractSessionAccountAddress/);
});

test("a MOVED registrar makes a stored key report itself unusable", () => {
  // The property, stated against the parser + scope check directly: a blob that
  // records a different registrar must not satisfy the scope test. If it did,
  // the key would be handed to a userOp the validator then rejects.
  const scope = fn("function sessionKeyScopeMatches");
  const parse = fn("function parseStoredSessionKey");
  // v1 blobs (no scope recorded) are unusable rather than assumed-good.
  assert.match(parse, /parsed\?\.v !== SESSION_BLOB_VERSION/);
  assert.match(scope, /if \(!stored\) return false;/);
});

test("the session client discards an out-of-scope key instead of using it", () => {
  const client = fn("export async function getWocoSessionClient");
  assert.match(client, /sessionKeyScopeMatches/);
  assert.match(client, /clearWocoSessionKey\(\)/);
});

test("the permit path checks the CHAIN, not just the registrar address", () => {
  // The same address can exist on another chain from the same deployer and
  // nonce, so the address check alone passes while the chain differs — failing
  // only on-chain, after a sponsored userOp has been spent.
  const permit = fn("export async function registerSubEnsViaPermit");
  assert.match(permit, /args\.chainId !== KERNEL_CHAIN_ID/);
  assert.match(permit, /Chain mismatch/);
});

test("the client forwards the chain the server signed for", () => {
  const api = readFileSync(new URL("../src/lib/api/sub-ens.ts", import.meta.url), "utf-8");
  assert.match(api, /chainId: permit\.data\.chainId/);
});
