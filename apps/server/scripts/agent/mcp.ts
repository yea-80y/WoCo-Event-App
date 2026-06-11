/**
 * WoCo Events — MCP server (stdio).
 *
 * Exposes the agent commerce surface as MCP tools so any MCP client (e.g. Claude
 * Desktop) can BE the agent: discover events, quote a ticket, and buy it. The
 * purchase is paid by drawing against a spend permission the user granted to
 * THIS agent's own key — the WoCo server never holds the key or the funds, and
 * the bounds (recipient, ceiling, expiry, count) are enforced on-chain.
 *
 * Config (env — the agent's identity + granted budget; set in apps/server/.env
 * or the MCP client's server config):
 *   AGENT_API_BASE          WoCo API base (default http://localhost:3001)
 *   ZERODEV_RPC             bundler+paymaster RPC for the draw
 *   WOCO_AGENT_PK           the agent's OWN private key (the granted spender)
 *   WOCO_AGENT_APPROVAL     serialized spend-permission approval the user granted
 *   WOCO_AGENT_USER_KERNEL  the user's Kernel (funds source + ticket recipient)
 *
 * Run (configure as an MCP stdio server, command):
 *   node --import tsx apps/server/scripts/agent/mcp.ts
 */

import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { agentDrawTransfer } from "./zerodev.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "../../.env") });

const API_BASE = (process.env.AGENT_API_BASE || "http://localhost:3001").replace(/\/+$/, "");

async function api(path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

function text(obj: unknown) {
  return { content: [{ type: "text" as const, text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}
function fail(msg: string) {
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

const server = new McpServer({ name: "woco-events-agent", version: "0.1.0" });

server.registerTool(
  "find_events",
  {
    description: "List WoCo events available to buy tickets for. Optionally filter by organiser address.",
    inputSchema: { organiser: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional() },
  },
  async ({ organiser }) => {
    const r = await api(`/api/agent/events${organiser ? `?organiser=${organiser}` : ""}`);
    if (!r.json.ok) return fail(r.json.error ?? "discovery failed");
    return text(r.json.data);
  },
);

server.registerTool(
  "get_event",
  {
    description: "Get a WoCo event's detail, including ticket series and USDC pricing.",
    inputSchema: { eventId: z.string() },
  },
  async ({ eventId }) => {
    const r = await api(`/api/agent/events/${eventId}`);
    if (!r.json.ok) return fail(r.json.error ?? "event not found");
    return text(r.json.data);
  },
);

server.registerTool(
  "get_quote",
  {
    description: "Get the exact USDC amount and organiser recipient for a ticket series.",
    inputSchema: { eventId: z.string(), seriesId: z.string() },
  },
  async ({ eventId, seriesId }) => {
    const r = await api("/api/agent/quote", { eventId, seriesId });
    if (!r.json.ok) return fail(r.json.error ?? "quote failed");
    return text(r.json.data);
  },
);

server.registerTool(
  "buy_ticket",
  {
    description:
      "Buy a ticket: quote it, draw the USDC from the user's granted spend-permission budget " +
      "(with the agent's own key — bounded on-chain), then settle to mint the ticket to the user.",
    inputSchema: { eventId: z.string(), seriesId: z.string() },
  },
  async ({ eventId, seriesId }) => {
    const agentPk = process.env.WOCO_AGENT_PK;
    const approval = process.env.WOCO_AGENT_APPROVAL;
    const userKernel = process.env.WOCO_AGENT_USER_KERNEL;
    if (!agentPk || !approval || !userKernel) {
      return fail("Agent budget not configured (WOCO_AGENT_PK / WOCO_AGENT_APPROVAL / WOCO_AGENT_USER_KERNEL).");
    }

    const q = await api("/api/agent/quote", { eventId, seriesId });
    if (!q.json.ok) return fail(q.json.error ?? "quote failed");
    const quote = q.json.data as {
      amountAtomic: string;
      recipient: string;
      usdcAddress: string;
      intentId: string;
    };

    let txHash: string;
    try {
      const draw = await agentDrawTransfer({
        approval,
        agentPrivateKey: agentPk,
        usdcAddress: quote.usdcAddress,
        recipient: quote.recipient,
        amountAtomic: quote.amountAtomic,
      });
      txHash = draw.txHash;
    } catch (err) {
      return fail(`spend-permission draw rejected: ${(err as Error).message}`);
    }

    const buy = await api("/api/agent/buy", {
      eventId,
      seriesId,
      userKernel,
      settlementTxHash: txHash,
      intentId: quote.intentId,
    });
    if (!buy.json.ok) return fail(`settle failed (${buy.status}): ${buy.json.error}`);

    return text({
      status: "ticket purchased",
      ticket: buy.json.data.ticket,
      paidUsdcAtomic: buy.json.data.amountAtomic,
      organiser: buy.json.data.recipient,
      drawTx: `https://sepolia.arbiscan.io/tx/${txHash}`,
    });
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio MCP servers must not write to stdout (it's the protocol channel).
  console.error("[woco-mcp] WoCo Events agent MCP server ready (stdio).");
}

main().catch((err) => {
  console.error("[woco-mcp] fatal:", err);
  process.exit(1);
});
