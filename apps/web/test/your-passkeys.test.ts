/**
 * "Your passkeys" (#746 step 3, part 2): the list the browser checks itself, the
 * device-local labels, the add flow's order, and the screens that must tell an
 * added passkey it cannot act as the owner before any passkey sheet opens.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Wallet, TypedDataEncoder } from "ethers";
import { DEVICE_GRANT_DOMAIN, DEVICE_GRANT_TYPES, credentialTagOf, type DeviceGrantMessage } from "@woco/shared";

const data = new Map<string, unknown>();
(globalThis as { indexedDB?: unknown }).indexedDB = (() => {
  const stores = new Set<string>();
  const fire = (req: Record<string, unknown>, result?: unknown) =>
    queueMicrotask(() => {
      req.result = result;
      (req.onsuccess as ((e: unknown) => void) | undefined)?.({ target: req });
    });
  const objectStore = () => ({
    get: (k: string) => { const req: Record<string, unknown> = {}; fire(req, data.has(k) ? data.get(k) : undefined); return req; },
    put: (v: unknown, k: string) => { const req: Record<string, unknown> = {}; data.set(k, v); fire(req); return req; },
    delete: (k: string) => { const req: Record<string, unknown> = {}; data.delete(k); fire(req); return req; },
    clear: () => { const req: Record<string, unknown> = {}; data.clear(); fire(req); return req; },
  });
  const db = {
    objectStoreNames: { contains: (n: string) => stores.has(n) },
    createObjectStore: (n: string) => { stores.add(n); return {}; },
    transaction: () => ({ objectStore }),
    onclose: null,
  };
  return {
    open: () => {
      const req: Record<string, unknown> = {};
      queueMicrotask(() => {
        req.result = db;
        (req.onupgradeneeded as ((e: unknown) => void) | undefined)?.({ target: req });
        (req.onsuccess as ((e: unknown) => void) | undefined)?.({ target: req });
      });
      return req;
    },
  };
})();

const { verifyDeviceGrantList, ownerFromOwnGrant } = await import("../src/lib/auth/device-grant-verify.ts");
const { readPasskeyMeta, writePasskeyMeta } = await import("../src/lib/auth/passkey-meta.ts");

const PARENT = Wallet.createRandom().address.toLowerCase();
const owner = Wallet.createRandom();
const types = DEVICE_GRANT_TYPES as unknown as Parameters<typeof TypedDataEncoder.hash>[1];

async function record(signer: Wallet, grantee: string, over: Partial<DeviceGrantMessage> = {}, revokedAt?: number) {
  const grant: DeviceGrantMessage = {
    parent: PARENT,
    grantee: grantee.toLowerCase(),
    credentialTag: credentialTagOf(new TextEncoder().encode(grantee)),
    issuedAt: 1790812800,
    nonce: "0x" + "ab".repeat(32),
    ...over,
  };
  return { grant, grantSig: await signer.signTypedData(DEVICE_GRANT_DOMAIN, types, grant), ...(revokedAt ? { revokedAt } : {}) };
}

test("only grants the current owner signed for THIS account are shown; removals as recorded", async () => {
  const a = Wallet.createRandom().address;
  const b = Wallet.createRandom().address;
  const records = [
    await record(owner, a),
    await record(Wallet.createRandom(), Wallet.createRandom().address), // someone else signed
    await record(owner, Wallet.createRandom().address, { parent: Wallet.createRandom().address.toLowerCase() }),
    await record(owner, b, {}, 1790900000000),
    { grant: { nope: true }, grantSig: "0x00" },
  ];
  const shown = verifyDeviceGrantList(records, { parent: PARENT, owner: owner.address });
  assert.deepEqual(shown.map((r) => r.grantee), [a.toLowerCase(), b.toLowerCase()]);
  assert.equal(shown[0]!.removedAt, null);
  assert.equal(shown[1]!.removedAt, 1790900000000);
});

test("a previous owner's grants are left out after the owner changes", async () => {
  const old = Wallet.createRandom();
  const records = [await record(old, Wallet.createRandom().address)];
  assert.deepEqual(verifyDeviceGrantList(records, { parent: PARENT, owner: owner.address }), []);
});

test("an added passkey finds the owner through its own live grant", async () => {
  const me = Wallet.createRandom().address;
  const records = [await record(owner, Wallet.createRandom().address), await record(owner, me)];
  assert.equal(ownerFromOwnGrant(records, me), owner.address.toLowerCase());
  assert.equal(ownerFromOwnGrant([await record(owner, me, {}, 1)], me), null, "a removed grant names no owner");
});

test("labels stay on this device, per account", async () => {
  data.clear();
  await writePasskeyMeta(PARENT, "0x" + "cd".repeat(32), { provider: "samsung-pass", addedAt: 1, credentialId: "AQID" });
  assert.equal((await readPasskeyMeta(PARENT))["0x" + "cd".repeat(32)]?.provider, "samsung-pass");
  assert.deepEqual(await readPasskeyMeta(Wallet.createRandom().address), {});
});

// ── Pinned at the source ────────────────────────────────────────────────────

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const STORE = read("../src/lib/auth/auth-store.svelte.ts");
function body(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist`);
  return src.slice(start, src.indexOf("\n}\n", start));
}

test("adding: envelope first, then on the list with its record, then the passkey record; never from a linked device", () => {
  const b = body(STORE, "async function addPasskeyOnThisDevice(");
  assert.match(b, /if \(_kind !== "passkey" \|\| _deviceRole\) throw new MainPasskeyRequiredError\(\);/);
  const envelope = b.indexOf("await writePortabilityEnvelope(");
  const register = b.indexOf("await _addCoOwnerWithRecord(\n    added.address,");
  const recordWrite = b.indexOf("await writePasskeyRecord(");
  assert.ok(envelope > 0 && register > envelope && recordWrite > register);
  const grant = body(STORE, "async function _grantDevice(");
  assert.match(grant, /await registerDeviceGrant\(grant, grantSig\);\s*if \(!res\.ok\) throw new Error\(_grantRefusalMessage\(res\)\);/);
});

test("the provider never leaves the device: not in the grant, the envelope or the record", () => {
  const b = body(STORE, "async function addPasskeyOnThisDevice(");
  assert.doesNotMatch(body(STORE, "async function _grantDevice("), /provider/);
  const envelope = b.slice(b.indexOf("await writePortabilityEnvelope("), b.indexOf(");", b.indexOf("await writePortabilityEnvelope(")));
  assert.doesNotMatch(envelope, /provider/);
  const rec = b.slice(b.indexOf("await writePasskeyRecord("), b.indexOf(");", b.indexOf("await writePasskeyRecord(")));
  assert.doesNotMatch(rec, /provider/);
  assert.doesNotMatch(read("../src/lib/api/device-grants.ts"), /provider/i);
});

test("removing: a legacy device only itself, a co-owner any - confirmed fresh, off the list before the record", () => {
  const confirm = body(STORE, "async function removePasskey(");
  assert.match(confirm, /if \(!_deviceRole\) await _freshMainPasskey\(\);\s*await _removePasskeyConfirmed\(grantee\);/);
  const b = body(STORE, "async function _removePasskeyConfirmed(");
  assert.match(b, /if \(_deviceRole && target !== self\) throw new MainPasskeyRequiredError\(\);/);
  // The list change lands before the device record is removed (Fable sign-off).
  assert.match(b, /await _rotateOnRemoval\(\[target\]\);/);
  // #186: another passkey leaves through the removal's rotation - off the list in the flip,
  // its device record only after it (rotate.ts runs the after steps past the flip).
  const rot = read("../src/lib/keyring/rotate.ts");
  assert.ok(rot.indexOf("await s.flip(pending.going") < rot.indexOf("await s.after[step](keys, { going: p.going });"), "off the list first");
  assert.ok(read("../src/lib/keyring/rotate.ts").includes('"records"'));
  assert.match(body(STORE, "async function _rotateOnRemoval("), /removeRecord: \(key\) => _removeRecordAfterList\(u\.parent, key\),/);
  assert.match(b, /if \(target === self\) await _forgetThisPasskey\(self\);/);
  assert.match(
    body(STORE, "async function _forgetThisPasskey("),
    /await _clearRecoveryBinding\(self\);\s*clearVerifiedBinding\("passkey", self\);[\s\S]*?await _forgetAddedPasskey\(self\);\s*await logout\(\{ force: true \}\);/,
  );
});

test("the screen never asks for a passkey on page open, never loops, and never leaves this origin", () => {
  const screen = read("../src/lib/components/passkeys/YourPasskeys.svelte");
  // Once per visit, from a NON-reactive flag: a reactive one re-ran a failing load
  // in a tight loop against the server (Fable sign-off #1).
  assert.match(screen, /let autoTried = false;\s*\$effect\(\(\) => \{\s*if \(isPasskey && auth\.hasSession && !autoTried\) \{\s*autoTried = true;\s*void load\(\);/);
  assert.doesNotMatch(screen, /let autoTried = \$state/);
  // One add at a time: busy from the tap.
  assert.match(screen, /if \(adding !== "explain"\) return;[\s\S]*?adding = "creating";\s*try \{/);
  assert.doesNotMatch(screen, /href="#\//);
  assert.doesNotMatch(read("../src/lib/components/profile/ProfilePage.svelte"), /href="#\/passkeys"/);
});

test("every live owner-only action tells an added passkey so before any passkey sheet", () => {
  const sources: Array<[string, string]> = [
    ["../src/lib/components/sub-ens/NamePointerPrompt.svelte", "async function point()"],
    ["../src/lib/creator/builder/DiscardNameDialog.svelte", "async function discard()"],
    ["../src/lib/components/recovery/AccountRecoverySetup.svelte", "async function chooseAndConnect("],
    ["../src/lib/components/recovery/AccountRecoverySetup.svelte", "async function confirmAndInstall()"],
    ["../src/lib/components/recovery/AccountRecoverySetup.svelte", "async function confirmRemove()"],
    ["../src/lib/components/recovery/AccountRecoverySetup.svelte", "async function revokeOne("],
    ["../src/lib/creator/builder/SubENSPicker.svelte", "async function doRelink()"],
  ];
  for (const [file, fn] of sources) {
    const src = read(file);
    const start = src.indexOf(fn);
    assert.ok(start > 0, `${fn} in ${file}`);
    const head = src.slice(start, start + 600);
    assert.match(head, /if \(!auth\.isAccountOwner\) \{[\s\S]*?MAIN_PASSKEY_REQUIRED_MESSAGE;[\s\S]*?return;/, `${fn} must check first`);
  }
});

test("a name an added passkey could never point is not minted by it", () => {
  const picker = read("../src/lib/creator/builder/SubENSPicker.svelte");
  const start = picker.indexOf("async function doClaim()");
  assert.match(picker.slice(start, start + 500), /if \(auth\.isConnected && !auth\.isAccountOwner\) \{\s*claimError = MAIN_PASSKEY_REQUIRED_MESSAGE;\s*return;/);
});

test("adding excludes the main passkey AND every passkey this device added before", () => {
  const b = body(STORE, "async function addPasskeyOnThisDevice(");
  assert.match(b, /\.\.\.\(pinned\?\.credentialId \? \[pinned\.credentialId\] : \[\]\),\s*\.\.\.Object\.values\(await readPasskeyMeta\(parent\)\)\.map\(\(m\) => m\.credentialId\),/);
});

test("more than one passkey needs an unlocked account: the screen follows the server's answer", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/lib/components/passkeys/YourPasskeys.svelte", import.meta.url)), "utf8");
  const data = readFileSync(fileURLToPath(new URL("../src/lib/auth/your-passkeys-data.ts", import.meta.url)), "utf8");
  assert.match(data, /canAdd: res\.data\.canAddDevices === true/);
  assert.match(src, /canAdd = res\.canAdd;/);
  const markup = src.slice(src.indexOf("</script>"));
  const gate = markup.indexOf("{#if !canAdd}");
  assert.ok(gate > 0 && gate < markup.indexOf("Add another device</button>"), "no add offer before the gate");
  assert.ok(gate < markup.indexOf("Add a password manager here"));
});
