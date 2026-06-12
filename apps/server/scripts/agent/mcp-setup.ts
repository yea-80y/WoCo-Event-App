/**
 * One-shot: provision the MCP agent's persistent identity + spend permission so
 * Claude Desktop (or any MCP client) can buy tickets autonomously.
 *
 * Unlike `demo.ts` (which mints an ephemeral agent key + grant per run), the MCP
 * server needs a STABLE agent key and a STABLE approval blob the client carries.
 * This script:
 *   1. derives/uses a fixed agent key (WOCO_AGENT_PK; generated + printed if unset),
 *   2. ensures the user Kernel is deployed,
 *   3. fetches the server-dictated bounds for the demo event (grant-params),
 *   4. has the user Kernel sign the spend-permission approval naming the agent,
 *   5. prints the `.env` lines + a ready-to-paste claude_desktop_config.json block.
 *
 * The approval expires at the server's window (24h) — re-run to refresh before a demo.
 *
 * Run (server must be reachable at AGENT_API_BASE; bee tunnel up for event reads):
 *   AGENT_API_BASE=https://events-api.woco-net.com \
 *     node --env-file=apps/server/.env --import tsx apps/server/scripts/agent/mcp-setup.ts
 */

import { fileURLToPath } from "url";
import { dirname, resolve, join } from "path";
import { homedir } from "os";
import { mkdirSync, writeFileSync, chmodSync } from "fs";
import { generatePrivateKey } from "viem/accounts";
import type { Address } from "viem";
import {
  buildKernelFromPrivateKey,
  ensureKernelDeployed,
  buildAgentSpendGrant,
  addressFromPrivateKey,
} from "./zerodev.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_PATH = resolve(__dirname, "mcp.ts");
const API_BASE = (process.env.AGENT_API_BASE || "http://localhost:3001").replace(/\/+$/, "");

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

async function main() {
  const userPk = need("AGENT_DEMO_USER_PK");
  const eventId = need("AGENT_DEMO_EVENT_ID");
  const agentPk = process.env.WOCO_AGENT_PK || generatePrivateKey();
  const agentAddress = addressFromPrivateKey(agentPk);

  console.log(`\nProvisioning MCP agent identity (API: ${API_BASE})…`);
  const user = await buildKernelFromPrivateKey(userPk);
  await ensureKernelDeployed(user);

  const gpRes = await fetch(`${API_BASE}/api/agent/grant-params`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentAddress, eventId }),
  });
  const gp = await gpRes.json();
  if (!gp.ok) throw new Error(`grant-params failed: ${gp.error}`);
  const p = gp.data as {
    usdcAddress: Address; recipient: Address; perDrawCeilingAtomic: string;
    maxDraws: number; validUntil: number;
  };

  const approval = await buildAgentSpendGrant({
    sudoValidator: user.sudoValidator,
    agentAddress,
    usdcAddress: p.usdcAddress,
    recipient: p.recipient,
    perDrawCeilingAtomic: p.perDrawCeilingAtomic,
    maxDraws: p.maxDraws,
    validUntil: p.validUntil,
  });

  const config = {
    mcpServers: {
      "woco-events-agent": {
        command: "node",
        args: ["--import", "tsx", MCP_PATH],
        env: {
          AGENT_API_BASE: API_BASE,
          ZERODEV_RPC: process.env.ZERODEV_RPC ?? "<set ZERODEV_RPC>",
          WOCO_AGENT_PK: agentPk,
          WOCO_AGENT_USER_KERNEL: user.address,
          WOCO_AGENT_APPROVAL: approval,
        },
      },
    },
  };

  console.log(`\n━━━ Agent provisioned ━━━`);
  console.log(`  agent address : ${agentAddress}`);
  console.log(`  user Kernel   : ${user.address}`);
  console.log(`  recipient     : ${p.recipient}  (organiser, pinned)`);
  console.log(`  expires       : ${new Date(p.validUntil * 1000).toISOString()}`);
  // Write straight to the Claude Desktop config path (created if missing). The
  // file holds short-lived testnet secrets, so it lives in ~/.config, never the
  // repo. If you already have other MCP servers configured, merge by hand instead
  // — re-running clobbers the whole file.
  const cfgDir = join(homedir(), ".config", "Claude");
  const cfgPath = join(cfgDir, "claude_desktop_config.json");
  // 0600/0700 — the file embeds the agent private key + approval. `mode` on
  // writeFileSync only applies on CREATE, so chmod after to also tighten a
  // pre-existing file left world-readable by an earlier run.
  mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
  writeFileSync(cfgPath, JSON.stringify(config, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  chmodSync(cfgPath, 0o600);
  console.log(`\n━━━ Wrote ${cfgPath} ━━━`);
  console.log(JSON.stringify(config, null, 2));
  console.log(`\nRestart Claude Desktop, then ask: "buy me a ticket to the WoCo demo event".`);
  console.log(`(Approval expires ${new Date(p.validUntil * 1000).toISOString()} — re-run this before the demo to refresh.)\n`);
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});
