/**
 * On-chain smoke for the likes verify path: attest a test like from the sponsor
 * EOA, prove the server's getVerifiedLike() decodes it correctly (attester +
 * subject + subjectType + revoked=false), then revoke and prove revoked=true.
 *
 * Validates the EAS calldata encoding AND the server verifier against the real
 * Arb Sepolia contract — the half we can't exercise without a browser+passkey.
 *
 * Run from repo root:
 *   node --import tsx apps/server/scripts/likes-onchain-smoke.ts
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import {
  JsonRpcProvider, Contract, Wallet, AbiCoder, hexlify, randomBytes,
} from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "../.env") });

import { EAS_ADDRESS, EAS_SCHEMA_UID, EAS_CHAIN_ID, SubjectType } from "@woco/shared";
import { getVerifiedLike } from "../src/lib/likes/eas-onchain.js";

const EAS_ABI = [
  "function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data)) payable returns (bytes32)",
  "function revoke((bytes32 schema,(bytes32 uid,uint256 value) data)) payable",
  "event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)",
];

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = "0x" + "00".repeat(32);

async function main() {
  const pk = process.env.WOCO_SPONSOR_PRIVATE_KEY;
  if (!pk) throw new Error("WOCO_SPONSOR_PRIVATE_KEY not set");
  const schema = (process.env.EAS_SCHEMA_UID ?? EAS_SCHEMA_UID) as string;

  const provider = new JsonRpcProvider("https://sepolia-rollup.arbitrum.io/rpc", EAS_CHAIN_ID);
  const wallet = new Wallet(pk, provider);
  const eas = new Contract(EAS_ADDRESS, EAS_ABI, wallet);

  const subject = hexlify(randomBytes(32));
  const subjectType = SubjectType.Profile; // 0
  const data = AbiCoder.defaultAbiCoder().encode(["bytes32", "uint8"], [subject, subjectType]);

  console.log(`attester (sponsor): ${wallet.address}`);
  console.log(`subject:            ${subject}`);

  // ── attest ────────────────────────────────────────────────────────────────
  const tx = await eas.attest({
    schema,
    data: { recipient: ZERO_ADDR, expirationTime: 0n, revocable: true, refUID: ZERO_HASH, data, value: 0n },
  });
  const rcpt = await tx.wait();
  const parsed = rcpt!.logs
    .map((l: any) => { try { return eas.interface.parseLog(l); } catch { return null; } })
    .find((p: any) => p?.name === "Attested");
  const uid = parsed!.args.uid as string;
  console.log(`attest tx: ${tx.hash}`);
  console.log(`uid:       ${uid}`);

  // ── verify (server path) ────────────────────────────────────────────────────
  const v1 = await getVerifiedLike(uid);
  console.log("getVerifiedLike (post-attest):", v1);
  if (!v1.ok) throw new Error("verify failed: " + v1.error);
  assert(v1.like.attester === wallet.address.toLowerCase(), "attester mismatch");
  assert(v1.like.subject === subject.toLowerCase(), "subject mismatch");
  assert(v1.like.subjectType === subjectType, "subjectType mismatch");
  assert(v1.like.revoked === false, "should not be revoked yet");
  console.log("✓ attest verified (attester + subject + subjectType + revoked=false)");

  // ── revoke ──────────────────────────────────────────────────────────────────
  const rtx = await eas.revoke({ schema, data: { uid, value: 0n } });
  await rtx.wait();
  console.log(`revoke tx: ${rtx.hash}`);

  const v2 = await getVerifiedLike(uid);
  console.log("getVerifiedLike (post-revoke):", { ok: v2.ok, revoked: v2.ok && v2.like.revoked });
  if (!v2.ok) throw new Error("verify failed: " + v2.error);
  assert(v2.like.revoked === true, "should be revoked now");
  console.log("✓ revoke verified (revoked=true)");

  console.log("\nALL OK");
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error("ASSERT: " + msg);
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
