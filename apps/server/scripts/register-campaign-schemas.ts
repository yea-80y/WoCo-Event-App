/**
 * One-time: register the onboarding-campaign EAS schemas on Arbitrum Sepolia.
 *
 *   referral: "address referrer",              resolver = 0x0, revocable = false
 *   badge:    "uint8 badgeType,uint32 epoch",  resolver = 0x0, revocable = true
 *
 * Schema UIDs are deterministic (keccak256(abi.encodePacked(schema, resolver,
 * revocable))), precomputed in packages/shared/src/campaign/types.ts. This
 * script asserts the on-chain derivation matches and is idempotent — an
 * already-registered schema is detected via getSchema and skipped.
 *
 * Run from repo root:
 *   node --import tsx apps/server/scripts/register-campaign-schemas.ts
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import {
  JsonRpcProvider, Contract, Wallet, keccak256, solidityPacked,
} from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "../.env") });

import {
  REFERRAL_SCHEMA, REFERRAL_REVOCABLE, EAS_REFERRAL_SCHEMA_UID,
  BADGE_SCHEMA, BADGE_REVOCABLE, EAS_BADGE_SCHEMA_UID,
  SCHEMA_REGISTRY_ADDRESS, EAS_CHAIN_ID,
} from "@woco/shared";

const RESOLVER = "0x0000000000000000000000000000000000000000";
const ZERO_UID = "0x".padEnd(66, "0");

const REGISTRY_ABI = [
  "function register(string schema, address resolver, bool revocable) returns (bytes32)",
  "function getSchema(bytes32 uid) view returns (tuple(bytes32 uid, address resolver, bool revocable, string schema))",
];

function computeSchemaUID(schema: string, revocable: boolean): string {
  return keccak256(solidityPacked(["string", "address", "bool"], [schema, RESOLVER, revocable]));
}

function rpcUrl(): string {
  return process.env[`RPC_URL_${EAS_CHAIN_ID}`] ?? "https://sepolia-rollup.arbitrum.io/rpc";
}

async function registerOne(
  registry: Contract,
  name: string,
  schema: string,
  revocable: boolean,
  expectedUid: string,
) {
  const predicted = computeSchemaUID(schema, revocable);
  console.log(`\n[${name}] schema: "${schema}"  revocable: ${revocable}`);
  console.log(`[${name}] predicted UID: ${predicted}`);
  if (predicted !== expectedUid) {
    throw new Error(
      `${name}: predicted UID ${predicted} != shared constant ${expectedUid} — fix packages/shared/src/campaign/types.ts before registering`,
    );
  }

  const existing = await registry.getSchema(predicted);
  if (existing.uid && existing.uid !== ZERO_UID) {
    console.log(`[${name}] already registered.`);
    return;
  }

  console.log(`[${name}] registering…`);
  const tx = await registry.register(schema, RESOLVER, revocable);
  console.log(`[${name}]   tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`[${name}]   mined in block ${receipt?.blockNumber}`);
  console.log(`[${name}]   explorer: https://sepolia.arbiscan.io/tx/${tx.hash}`);
}

async function main() {
  const pk = process.env.WOCO_SPONSOR_PRIVATE_KEY;
  if (!pk) throw new Error("WOCO_SPONSOR_PRIVATE_KEY is not set");

  const provider = new JsonRpcProvider(rpcUrl(), EAS_CHAIN_ID);
  const wallet = new Wallet(pk, provider);
  const registry = new Contract(SCHEMA_REGISTRY_ADDRESS, REGISTRY_ABI, wallet);
  console.log(`registrar: ${wallet.address}  chain: ${EAS_CHAIN_ID}`);

  await registerOne(registry, "referral", REFERRAL_SCHEMA, REFERRAL_REVOCABLE, EAS_REFERRAL_SCHEMA_UID);
  await registerOne(registry, "badge", BADGE_SCHEMA, BADGE_REVOCABLE, EAS_BADGE_SCHEMA_UID);

  console.log(`\nEAS_REFERRAL_SCHEMA_UID=${EAS_REFERRAL_SCHEMA_UID}`);
  console.log(`EAS_BADGE_SCHEMA_UID=${EAS_BADGE_SCHEMA_UID}`);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
