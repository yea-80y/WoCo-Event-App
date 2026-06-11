/**
 * WoCo agent commerce — end-to-end demo (Arbitrum Sepolia).
 *
 * Proves the bounded non-custodial agent wallet:
 *   1. A test USER Kernel grants a spend permission to the AGENT's OWN key,
 *      pinned to one organiser, a per-draw ceiling, an expiry, and a draw count.
 *   2. The AGENT discovers the event, quotes the ticket, and DRAWS USDC with its
 *      own key (the WoCo server never holds the key or the funds).
 *   3. The AGENT settles via POST /api/agent/buy → ticket minted to the user.
 *   4. A deliberately WRONG-RECIPIENT draw is REJECTED on-chain — the bounds bite.
 *
 * Prerequisites (set in apps/server/.env or the shell):
 *   ZERODEV_RPC            — server bundler+paymaster RPC (already set for the POS rail)
 *   AGENT_API_BASE         — WoCo API base (default http://localhost:3001)
 *   AGENT_DEMO_USER_PK     — 0x… test user private key (its Kernel must hold test USDC)
 *   AGENT_DEMO_EVENT_ID    — a published event with a USDC/direct-transfer series on 421614
 *   AGENT_DEMO_SERIES_ID   — the series to buy
 *   AGENT_DEMO_AGENT_PK    — (optional) fixed agent key; otherwise a fresh one is generated
 *
 * Run from repo root:
 *   node --import tsx apps/server/scripts/agent/demo.ts
 */

import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { createPublicClient, http, getContract, type Address } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { generatePrivateKey } from "viem/accounts";
import {
  buildKernelFromPrivateKey,
  buildAgentSpendGrant,
  agentDrawTransfer,
  addressFromPrivateKey,
} from "./zerodev.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "../../.env") });

const API_BASE = (process.env.AGENT_API_BASE || "http://localhost:3001").replace(/\/+$/, "");

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

async function api(path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

function usdc(atomic: string): string {
  return `$${(Number(BigInt(atomic)) / 1e6).toFixed(2)}`;
}

async function main() {
  const userPk = need("AGENT_DEMO_USER_PK");
  const eventId = need("AGENT_DEMO_EVENT_ID");
  const seriesId = need("AGENT_DEMO_SERIES_ID");
  const agentPk = process.env.AGENT_DEMO_AGENT_PK || generatePrivateKey();
  const agentAddress = addressFromPrivateKey(agentPk);

  console.log("━━━ WoCo Agent Commerce — E2E demo (Arbitrum Sepolia) ━━━\n");
  console.log(`API base   : ${API_BASE}`);
  console.log(`Agent addr : ${agentAddress}   (the agent's OWN key — server never sees it)`);

  // 1. Build the user's Kernel + check it holds USDC.
  const user = await buildKernelFromPrivateKey(userPk);
  console.log(`User Kernel: ${user.address}   (funds source + ticket recipient)\n`);

  // 2. Server-dictated bounds for the grant (recipient resolved from the event).
  const gp = await api("/api/agent/grant-params", { agentAddress, eventId });
  if (!gp.json.ok) throw new Error(`grant-params failed: ${gp.json.error}`);
  const params = gp.json.data as {
    usdcAddress: Address;
    recipient: Address;
    perDrawCeilingAtomic: string;
    maxDraws: number;
    validUntil: number;
    maxCapAtomic: string;
  };
  console.log("Bounds the user is about to grant the agent:");
  console.log(`  recipient (organiser, pinned): ${params.recipient}`);
  console.log(`  per-draw ceiling             : ${usdc(params.perDrawCeilingAtomic)}`);
  console.log(`  max draws                    : ${params.maxDraws}`);
  console.log(`  expires                      : ${new Date(params.validUntil * 1000).toISOString()}\n`);

  // Balance check (clear funding message if short).
  const pub = createPublicClient({ chain: arbitrumSepolia, transport: http(process.env.ZERODEV_RPC) });
  const token = getContract({ address: params.usdcAddress, abi: ERC20_BALANCE_ABI, client: pub });
  const bal = (await token.read.balanceOf([user.address as Address])) as bigint;
  console.log(`User Kernel USDC balance: ${usdc(bal.toString())}`);
  if (bal === 0n) {
    console.log(
      `\n⚠  Fund the user Kernel with test USDC (${params.usdcAddress}) on Arb Sepolia, then re-run.\n`,
    );
  }

  // 3. Quote the ticket (exact amount the agent must draw).
  const q = await api("/api/agent/quote", { eventId, seriesId });
  if (!q.json.ok) throw new Error(`quote failed: ${q.json.error}`);
  const quote = q.json.data as {
    amountAtomic: string;
    recipient: Address;
    usdcAddress: Address;
    intentId: string;
  };
  console.log(`\nQuote: ${quote.recipient} wants ${usdc(quote.amountAtomic)} USDC for "${q.json.data.seriesName}"\n`);

  // 4. USER grants the spend permission to the AGENT's address (one sudo signature).
  console.log("→ User Kernel signs the spend-permission grant (names the agent as spender)…");
  const approval = await buildAgentSpendGrant({
    sudoValidator: user.sudoValidator,
    agentAddress,
    usdcAddress: params.usdcAddress,
    recipient: params.recipient,
    perDrawCeilingAtomic: params.perDrawCeilingAtomic,
    maxDraws: params.maxDraws,
    validUntil: params.validUntil,
  });
  console.log("  granted (serialized approval handed to the agent — no key inside)\n");

  // 5. AGENT draws with its OWN key → USDC userKernel→organiser.
  console.log("→ Agent draws USDC with its own key (gasless userOp)…");
  const draw = await agentDrawTransfer({
    approval,
    agentPrivateKey: agentPk,
    usdcAddress: quote.usdcAddress,
    recipient: quote.recipient,
    amountAtomic: quote.amountAtomic,
  });
  console.log(`  draw tx: https://sepolia.arbiscan.io/tx/${draw.txHash}\n`);

  // 6. AGENT settles the purchase → ticket minted to the user Kernel.
  console.log("→ Agent settles via POST /api/agent/buy…");
  const buy = await api("/api/agent/buy", {
    eventId,
    seriesId,
    userKernel: user.address,
    settlementTxHash: draw.txHash,
    intentId: quote.intentId,
  });
  if (!buy.json.ok) throw new Error(`buy failed (${buy.status}): ${buy.json.error}`);
  const t = buy.json.data.ticket;
  console.log(`  🎟  TICKET MINTED to ${user.address}`);
  console.log(`     ${t.seriesName ?? seriesId} — edition #${t.edition ?? "?"}`);
  console.log(`     paid ${usdc(buy.json.data.amountAtomic)} to ${buy.json.data.recipient}\n`);

  // 7. Bounds bite — a WRONG-RECIPIENT draw must be rejected on-chain.
  console.log("→ Negative test: agent attempts to pay a DIFFERENT address (should be rejected)…");
  const attacker = addressFromPrivateKey(generatePrivateKey());
  try {
    await agentDrawTransfer({
      approval,
      agentPrivateKey: agentPk,
      usdcAddress: quote.usdcAddress,
      recipient: attacker, // not the pinned organiser
      amountAtomic: quote.amountAtomic,
    });
    console.log("  ✗ UNEXPECTED: the off-policy draw succeeded — investigate the call policy!\n");
  } catch (err) {
    console.log(`  ✓ rejected by the smart account (call policy pins recipient): ${(err as Error).message.slice(0, 120)}\n`);
  }

  console.log("━━━ done ━━━");
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});
