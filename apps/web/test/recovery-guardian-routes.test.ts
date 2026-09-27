/**
 * The two routes to a guardian's escrow keys (#642).
 *
 * A wallet or email guardian derives them from keccak256 of a deterministic
 * signature; a BACKUP PASSKEY derives them from its PRF output, so the escrowed
 * seed is not one secp256k1 break away through the guardian's owner key. Pinned:
 *  - `deriveGuardianKeysForBackup` takes the passkey route whenever the backup
 *    carries one, and then NEVER asks it to sign;
 *  - both routes share the same master → keys step, so a passkey guardian's escrow
 *    opens with exactly the keys setup sealed it to;
 *  - every call site goes through the one entry point, so the routes cannot be
 *    mixed up where a backup is used.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { passkeyGuardianEscrowMaster, type EIP712Signer } from "@woco/shared";
import {
  deriveGuardianKeys,
  deriveGuardianKeysForBackup,
  guardianKeysFromMaster,
  sealRecoveryBundle,
  openRecoveryBundle,
} from "../src/lib/auth/recovery-escrow.js";

const KERNEL = "0x" + "aa".repeat(20);
const PRF = "0x" + "cd".repeat(32);

const refusingSigner: EIP712Signer = async () => {
  throw new Error("a passkey guardian must never be asked to sign for its escrow keys");
};

test("a passkey backup takes its PRF route and is never asked to sign", async () => {
  const master = passkeyGuardianEscrowMaster(PRF);
  const backup = {
    address: "0x" + "12".repeat(20),
    signTypedData: refusingSigner,
    deriveEscrowKeys: () => guardianKeysFromMaster(master),
  };
  const a = await deriveGuardianKeysForBackup(backup);
  const b = await deriveGuardianKeysForBackup(backup);
  assert.equal(a.socSigner.address, b.socSigner.address, "deterministic across the setup self-check");

  const envelope = await sealRecoveryBundle({
    bundle: { version: 1, secrets: { identitySeed: "0x" + "ab".repeat(32) } },
    kernelAddress: KERNEL,
    role: "guardian",
    guardianPublicKeysHex: [a.encryption.publicKeyHex],
  });
  const opened = await openRecoveryBundle({ envelope, kernelAddress: KERNEL, role: "guardian", guardianKeypair: b.encryption });
  assert.equal(opened.secrets.identitySeed, "0x" + "ab".repeat(32));
});

test("a wallet backup signs, and its keys differ from any passkey guardian's", async () => {
  const { Wallet } = await import("ethers");
  const wallet = new Wallet("0x" + "34".repeat(32));
  let signatures = 0;
  const signer: EIP712Signer = (domain, types, message) => {
    signatures++;
    return wallet.signTypedData(
      domain as Parameters<Wallet["signTypedData"]>[0],
      types as Parameters<Wallet["signTypedData"]>[1],
      message as Parameters<Wallet["signTypedData"]>[2],
    );
  };
  const viaEntry = await deriveGuardianKeysForBackup({ address: wallet.address, signTypedData: signer });
  const direct = await deriveGuardianKeys(wallet.address, signer);
  assert.equal(signatures, 2);
  assert.equal(viaEntry.socSigner.address, direct.socSigner.address);
  const passkey = await guardianKeysFromMaster(passkeyGuardianEscrowMaster(PRF));
  assert.notEqual(viaEntry.socSigner.address, passkey.socSigner.address);
});

test("guardianKeysFromMaster leaves the caller's master intact (a passkey backup derives twice)", async () => {
  const master = passkeyGuardianEscrowMaster(PRF);
  const before = Buffer.from(master).toString("hex");
  await guardianKeysFromMaster(master);
  assert.equal(Buffer.from(master).toString("hex"), before);
  await assert.rejects(guardianKeysFromMaster(new Uint8Array(31)), /32 bytes/);
});

test("every place a backup is used goes through the one entry point, and the passkey backup supplies its route", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  for (const rel of [
    "../src/lib/auth/auth-store.svelte.ts",
    "../src/lib/components/recovery/AccountRecoverPortal.svelte",
  ]) {
    const src = read(rel);
    assert.doesNotMatch(src, /deriveGuardianKeys\(backup\./, `${rel} bypasses deriveGuardianKeysForBackup`);
    assert.match(src, /deriveGuardianKeysForBackup\(backup\)/, `${rel} must use the entry point`);
  }
  const signer = read("../src/lib/wallet/backup-signer.ts");
  const passkey = signer.slice(signer.indexOf("export async function connectPasskeyBackup"));
  assert.match(passkey.slice(0, passkey.indexOf("\n}\n")), /deriveEscrowKeys: async \(\) =>[\s\S]*guardianKeysFromMaster\(escrowMaster\)/);
});
