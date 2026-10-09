/**
 * The auth store's handling of the account's later secrets (#186). The store's state
 * is module-private, so these pin the invariants on its source, as seed-lock.test.ts does.
 * The rule they guard: nothing signs, seals or is cached as the account's signer until
 * the chain has CONFIRMED which generation is current - and any failure is a refusal.
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

test("an unlock derives and caches no signer itself; it resets the verdict and loads the chain", () => {
  const set = body("function _setUnlockedSeed");
  assert.doesNotMatch(set, /deriveFeedSignerKey|storeFeedSignerCache|writePublicKeys|_feedSignerCache =/);
  assert.match(set, /_keysVerdict = "pending";/);
});

test("the signer is committed only on an \"ok\" verdict, and any failure is short of ok", () => {
  const load = body("async function _loadAccountChain");
  assert.match(load, /_keysVerdict = verdict;\s*if \(verdict === "ok"\) _commitSigner\(\);/);
  assert.match(load, /catch \(e\) \{[\s\S]*_keysVerdict = "unknown";/);
  assert.match(body("function _commitSigner"), /deriveFeedSignerKey\(currentSecretOf\(u\.seed, u\.chain\)\)/);
});

test("an unreadable chain is unknown, never ok; a lagging \"none\" keeps the ring held", () => {
  const v = body("async function _verifyCurrentKeys");
  assert.match(v, /if \(ref === "error"\) return "unknown";/);
  assert.match(v, /if \(ref === held \|\| ref === null\) return "ok";/);
  assert.match(v, /if \(!prf\) return "behind";/);
});

test("signing and sealing demand the confirmed generation; silent paths sign nothing otherwise", () => {
  const inner = body("async function _getContentFeedSignerInner");
  const req = inner.indexOf("await _requireCurrentKeys(");
  assert.ok(req > 0 && req < inner.indexOf("deriveFeedSignerKey("), "require before derive");
  for (const sig of ["async function _feedSignerIfPresent", "async function _getContentFeedSignerAddress"]) {
    const b = body(sig);
    const gate = b.indexOf("if (!(await _currentKeysConfirmed())) return null;");
    assert.ok(gate > 0 && gate < b.indexOf("deriveFeedSignerKey("), `${sig}: gate before derive`);
  }
  assert.match(body("async function _accountSecretsIfPresent"), /if \(opts\.toSeal\) await _requireCurrentKeys\(\{ prompt: true \}\);/);
  assert.match(body("async function _requireCurrentKeys"), /if \(_keysVerdict !== "ok"\) throw new Error/);
});

test("a cached signer signs only for the ring it was committed under", () => {
  const b = body("async function _feedSignerIfPresent");
  assert.match(b, /if \(anchor === "error" \|\| \(anchor !== null && anchor !== cached\.ringRef\)\) return null;/);
});

test("a seed restored without the chain's window copy - while a locked chain exists - is relocked", () => {
  assert.match(body("async function _loadAccountChain"), /else if \(!prf && \(await hasLockedChain\(seedAddr\)\)\) \{[\s\S]*_relockPasskey\(\);/);
});

test("a relock drops the chain and the verdict with the seed", () => {
  assert.match(body("function _relockPasskey"), /_unlocked = null;\s*_chainLoad = null;\s*_keysVerdict = "pending";/);
});

test("an adopted ring is stored locked BEFORE it is used, and the box key is zeroed", () => {
  const sync = body("async function _syncKeyRing");
  const store = sync.indexOf("await storeLockedChain(");
  assert.ok(store > 0 && store < sync.indexOf("_applyChain(res.chain"), "store, then apply");
  assert.match(sync, /finally \{\s*box\.secretKey\.fill\(0\);/);
  assert.match(sync, /if \(!stillOurs\) return "unknown";/);
});

test("sign-out and an account switch close the chain's window copy too", () => {
  assert.equal((STORE.match(/clearChainWindow\(/g) ?? []).length, 2);
});
