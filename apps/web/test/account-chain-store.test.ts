/**
 * The auth store's handling of the account's later secrets (#186). The store's state
 * is module-private, so these pin the invariants on its source, as seed-lock.test.ts does.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const STORE = readFileSync(fileURLToPath(new URL("../src/lib/auth/auth-store.svelte.ts", import.meta.url)), "utf8");
function body(signature: string): string {
  const start = STORE.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist - a rename would make this pass vacuously`);
  return STORE.slice(start, STORE.indexOf("\n}\n", start));
}

test("every unlock signs under the CURRENT generation, never the bare seed", () => {
  assert.match(body("function _setUnlockedSeed"), /deriveFeedSignerKey\(currentSecretOf\(seed, chain\)\)/);
  assert.match(body("function _applyChain"), /deriveFeedSignerKey\(currentSecretOf\(u\.seed, chain\)\)/);
  assert.doesNotMatch(body("function _setUnlockedSeed"), /deriveFeedSignerKey\(seed\)/);
});

test("the signing getters wait for the chain before deriving anything", () => {
  for (const sig of ["async function _getContentFeedSignerInner", "async function _feedSignerIfPresent", "async function _getContentFeedSignerAddress", "async function _accountSecretsIfPresent"]) {
    const b = body(sig);
    const wait = b.indexOf("await _chainReady()");
    assert.ok(wait > 0, `${sig} waits for the chain`);
    const derive = b.search(/deriveFeedSignerKey\(|currentSecretOf\(/);
    assert.ok(derive > wait, `${sig} derives only after the wait`);
  }
});

test("a seed restored from its window without the chain's window copy - while a locked chain exists - is relocked", () => {
  const load = body("async function _loadAccountChain");
  assert.match(load, /else if \(!prf && \(await hasLockedChain\(seedAddr\)\)\) \{[\s\S]*_relockPasskey\(\);/);
});

test("a relock drops the chain and any check in flight with the seed", () => {
  const relock = body("function _relockPasskey");
  assert.match(relock, /_unlocked = null;\s*_chainLoad = null;\s*_ringSync = null;/);
});

test("an adopted ring is stored locked BEFORE it is used, and the box key is zeroed", () => {
  const sync = body("async function _syncKeyRing");
  const store = sync.indexOf("await storeLockedChain(");
  const apply = sync.indexOf("_applyChain(res.chain");
  assert.ok(store > 0 && apply > store, "store, then apply");
  assert.match(sync, /finally \{\s*box\.secretKey\.fill\(0\);/);
  // A ring for a different moment (relock, account switch) is not applied.
  assert.match(sync, /if \(!stillOurs\) return;/);
});

test("sign-out and an account switch close the chain's window copy too", () => {
  assert.equal((STORE.match(/clearChainWindow\(/g) ?? []).length, 2);
});
