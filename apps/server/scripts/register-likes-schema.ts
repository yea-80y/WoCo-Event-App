/**
 * One-time: register the EAS likes schema on Arbitrum Sepolia.
 *
 * Schema: "bytes32 subject,uint8 subjectType", resolver = address(0),
 * revocable = true. The schema UID is deterministic
 * (keccak256(abi.encodePacked(schema, resolver, revocable))) so re-running is
 * idempotent — if the schema already exists, SchemaRegistry.register reverts
 * with AlreadyExists and we just print the precomputed UID.
 *
 * Run from repo root:
 *   node --import tsx apps/server/scripts/register-likes-schema.ts
 *
 * Then record the printed UID as EAS_SCHEMA_UID in apps/server/.env (master)
 * and in packages/shared/src/likes/types.ts.
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import {
  JsonRpcProvider, Contract, Wallet, keccak256, solidityPacked,
} from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "../.env") });

import { LIKE_SCHEMA, SCHEMA_REGISTRY_ADDRESS, EAS_CHAIN_ID } from "@woco/shared";

const RESOLVER = "0x0000000000000000000000000000000000000000";
const REVOCABLE = true;

const REGISTRY_ABI = [
  "function register(string schema, address resolver, bool revocable) returns (bytes32)",
  "function getSchema(bytes32 uid) view returns (tuple(bytes32 uid, address resolver, bool revocable, string schema))",
];

// EAS computes the UID as keccak256(abi.encodePacked(schema, resolver, revocable)).
function computeSchemaUID(): string {
  return keccak256(solidityPacked(["string", "address", "bool"], [LIKE_SCHEMA, RESOLVER, REVOCABLE]));
}

function rpcUrl(): string {
  return process.env[`RPC_URL_${EAS_CHAIN_ID}`] ?? "https://sepolia-rollup.arbitrum.io/rpc";
}

async function main() {
  const pk = process.env.WOCO_SPONSOR_PRIVATE_KEY;
  if (!pk) throw new Error("WOCO_SPONSOR_PRIVATE_KEY is not set");

  const provider = new JsonRpcProvider(rpcUrl(), EAS_CHAIN_ID);
  const wallet = new Wallet(pk, provider);
  const registry = new Contract(SCHEMA_REGISTRY_ADDRESS, REGISTRY_ABI, wallet);

  const predicted = computeSchemaUID();
  console.log(`schema:     "${LIKE_SCHEMA}"`);
  console.log(`resolver:   ${RESOLVER}`);
  console.log(`revocable:  ${REVOCABLE}`);
  console.log(`predicted UID: ${predicted}`);
  console.log(`registrar:  ${wallet.address}`);

  // Idempotency: a registered schema has a non-zero uid in its record.
  const existing = await registry.getSchema(predicted);
  if (existing.uid && existing.uid !== "0x".padEnd(66, "0")) {
    console.log(`\nAlready registered. EAS_SCHEMA_UID=${existing.uid}`);
    return;
  }

  console.log(`\nregistering…`);
  const tx = await registry.register(LIKE_SCHEMA, RESOLVER, REVOCABLE);
  console.log(`  tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  mined in block ${receipt?.blockNumber}`);
  console.log(`  explorer: https://sepolia.arbiscan.io/tx/${tx.hash}`);
  console.log(`\nEAS_SCHEMA_UID=${predicted}`);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
