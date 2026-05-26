/**
 * Smoke test: call WoCoEvent.registerEvent on Arbitrum Sepolia via the sponsor
 * wallet path used by the live publish flow. Uses a synthetic manifestRef so
 * no Swarm writes occur — only the on-chain registration is exercised.
 *
 * Run from repo root:
 *   WOCO_EVENT_CHAIN_ID=421614 node --import tsx \
 *     apps/server/scripts/arbitrum-register-smoke.ts
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { randomBytes } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "../.env") });

import { registerEventOnChain } from "../src/lib/chain/sponsor-wallet.js";
import { getActiveChainId, getWoCoEventAddress } from "../src/lib/chain/event-contract.js";

async function main() {
  const chainId = getActiveChainId();
  const contractAddr = getWoCoEventAddress(chainId);
  console.log(`chainId=${chainId} contract=${contractAddr}`);

  if (chainId !== 421614) {
    console.warn(`!!! expected chainId 421614, got ${chainId} — set WOCO_EVENT_CHAIN_ID=421614`);
  }

  const supply = 5;
  const manifestRef = "0x" + randomBytes(32).toString("hex");

  console.log(`calling registerEvent(supply=${supply}, manifestRef=${manifestRef.slice(0, 14)}…)`);
  const { onChainEventId, txHash } = await registerEventOnChain(supply, manifestRef);

  console.log("OK");
  console.log(`  onChainEventId: ${onChainEventId}`);
  console.log(`  txHash:         ${txHash}`);
  console.log(`  explorer:       https://sepolia.arbiscan.io/tx/${txHash}`);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
