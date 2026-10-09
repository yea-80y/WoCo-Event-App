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
// The flows load lazily from account-keys.ts, working on the store's state through its host.
const KEYS = readFileSync(fileURLToPath(new URL("../src/lib/keyring/account-keys.ts", import.meta.url)), "utf8");
function bodyIn(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist - a rename would make this pass vacuously`);
  return src.slice(start, src.indexOf("\n}\n", start));
}
const body = (signature: string) => bodyIn(STORE, signature);
const kbody = (signature: string) => bodyIn(KEYS, signature);

test("the store lends its real state and gates to the lazy flows", () => {
  const host = body("function _keysHost(");
  for (const wire of [
    /setVerdict: \(v\) => \{\s*_keysVerdict = v;/,
    /commitSigner: \(\) => _commitSigner\(\),/,
    /requireCurrentKeys: \(o\) => _requireCurrentKeys\(o\),/,
    /currentKeysConfirmed: \(\) => _currentKeysConfirmed\(\),/,
    /relock: \(\) => _relockPasskey\(\),/,
    /removeRecordAfterList: \(parent, key\) => _removeRecordAfterList\(parent, key\),/,
  ]) {
    assert.match(host, wire);
  }
});

test("an unlock derives and caches no signer itself; it resets the verdict and loads the chain", () => {
  const set = body("function _setUnlockedSeed");
  assert.doesNotMatch(set, /deriveFeedSignerKey|storeFeedSignerCache|writePublicKeys|_feedSignerCache =/);
  assert.match(set, /_keysVerdict = "pending";/);
});

test("the signer is committed only on an \"ok\" verdict, and any failure is short of ok", () => {
  const load = kbody("export async function loadAccountChain");
  assert.match(load, /h\.setVerdict\(verdict\);\s*if \(verdict === "ok"\) \{\s*h\.commitSigner\(\);/);
  assert.match(load, /catch \(e\) \{[\s\S]*h\.setVerdict\("unknown"\);/);
  // The module failing to load is a failure too.
  assert.match(body("async function _loadAccountChain"), /catch \(e\) \{[\s\S]*_keysVerdict = "unknown";/);
  assert.match(body("function _commitSigner"), /deriveFeedSignerKey\(currentSecretOf\(u\.seed, u\.chain\)\)/);
});

test("an unreadable chain is unknown, never ok; a lagging \"none\" keeps the ring held", () => {
  const v = kbody("export async function verifyCurrentKeys");
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

test("a device behind catches up only with the passkey, and enrols itself only on a confirmed verdict", () => {
  assert.match(body("async function _requireCurrentKeys"), /if \(_keysVerdict === "behind" && opts\.prompt\) await \(await _keys\(\)\)\.catchUp\(_keysHost\(\)\);/);
  assert.match(kbody("export async function catchUp"), /await h\.ensurePasskeyKey\(\);[\s\S]*if \(verdict === "ok"\) h\.commitSigner\(\);/);
  assert.match(kbody("export async function enrolSelfInKeyRing"), /if \(!h\.isPasskey\(\) \|\| h\.deviceRole\(\) \|\| !\(await h\.currentKeysConfirmed\(\)\)\) return;/);
  assert.match(kbody("export async function rotateOnRemovalFor"), /^[^\n]*\n\s*await h\.requireCurrentKeys\(\{ prompt: true \}\);/);
});

test("a cached signer signs only for the ring it was committed under", () => {
  const b = body("async function _feedSignerIfPresent");
  assert.match(b, /if \(anchor === "error" \|\| \(anchor !== null && anchor !== cached\.ringRef\)\) return null;/);
});

test("a seed restored without the chain's window copy - while a locked chain exists - is relocked", () => {
  assert.match(kbody("export async function loadAccountChain"), /else if \(!prf && \(await hasLockedChain\(seedAddr\)\)\) \{[\s\S]*h\.relock\(\);/);
});

test("a relock drops the chain and the verdict with the seed", () => {
  assert.match(body("function _relockPasskey"), /_unlocked = null;\s*_chainLoad = null;\s*_keysVerdict = "pending";/);
});

test("an adopted ring is stored locked BEFORE it is used, and the box key is zeroed", () => {
  const sync = kbody("async function syncKeyRing");
  const store = sync.indexOf("await storeLockedChain(");
  assert.ok(store > 0 && store < sync.indexOf("applyChain(h, res.chain"), "store, then apply");
  assert.match(sync, /finally \{\s*box\.secretKey\.fill\(0\);/);
  assert.match(sync, /if \(!stillOurs\) return "unknown";/);
});

test("sign-out and an account switch close the chain's window copy too", () => {
  assert.equal((STORE.match(/clearChainWindow\(/g) ?? []).length, 2);
});

test("adding or linking: the ring includes this device, is built from the CONFIRMED generation, and never re-seals to a key off the list", () => {
  const r = kbody("export async function ringForChange");
  const gate = r.indexOf("await h.requireCurrentKeys({ prompt: true });");
  assert.ok(gate > 0 && gate < r.indexOf("members.ringWithMembers("));
  assert.match(r, /if \(ref !== held\) throw new Error\(keysVerdictMessage\("behind"\)\);/);
  assert.match(r, /onChain: \[\.\.\.listed, \.\.\.add\.map\(\(m\) => m\.statement\.coOwner\)\]/);
  assert.match(r, /const selfMember = inRing\.has\(self\) \? \[\] : \[await members\.memberOf\(/);
});

test("a linked device stores the handed-over secrets BEFORE it signs in, then adds itself", () => {
  const link = body("async function linkThisDevice");
  const store = link.indexOf("await storeLockedChain(");
  assert.ok(store > 0 && store < link.indexOf("await _loginAddedPasskey("), "chain before the sign-in's unlock");
  assert.ok(link.indexOf("void _enrolSelfInKeyRing();") > link.indexOf("await _loginAddedPasskey("));
});


test("an unfinished removal: past the flip it finishes by itself, before it the person decides", () => {
  const load = kbody("export async function loadAccountChain");
  assert.match(load, /if \(verdict === "ok"\) \{[\s\S]*if \(prf\) void removalLeftHere\(h, seedAddr\);/, "only on a confirmed unlock");
  const left = kbody("async function removalLeftHere");
  assert.match(left, /if \(flipped\) await rotateOnRemovalFor\(h, \[\], \{ resume: true \}\);\s*else h\.setPendingRemoval\(\{ going: p\.going \}\);/);
  assert.match(left, /if \(!p \|\| p\.parent !== u\.parent\) return;/);
});
