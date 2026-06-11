/**
 * Agent discovery documents — the machine-readable face of the agent commerce
 * surface. Two artifacts an autonomous agent (or its operator) fetches to learn
 * what WoCo offers and how to pay:
 *
 *  - GET /.well-known/agent.json  → the agent card (capabilities, payment scheme,
 *    MCP + OpenAPI URLs). Mirrors the emerging `.well-known/agent.json` convention.
 *  - GET /api/agent/openapi.json  → OpenAPI 3.1 for the /api/agent/* endpoints.
 *
 * Both are generated from the runtime base URL so they are correct on localhost,
 * the dev tunnel, and production (events-api.woco-net.com) without edits.
 */

/** Resolve the public base URL (no trailing slash). */
export function agentBaseUrl(): string {
  const base = process.env.PUBLIC_API_BASE || `http://localhost:${process.env.PORT || 3001}`;
  return base.replace(/\/+$/, "");
}

/**
 * The agent card. Headline is the payment model: a non-custodial, on-chain
 * spend-permission budget the user grants to the agent's OWN key — not a funded
 * hot wallet. Bounded by recipient, per-draw ceiling, expiry, and draw count;
 * enforced by the user's ERC-4337 (ZeroDev Kernel) smart account on Arbitrum.
 */
export function agentCard(base: string = agentBaseUrl()) {
  return {
    schemaVersion: "0.1",
    name: "WoCo Events Agent",
    description:
      "Discover decentralised events and buy tickets autonomously, paid in USDC on " +
      "Arbitrum via a bounded, non-custodial spend permission the user grants to the " +
      "agent's own key. The agent never holds funds or an unbounded key.",
    provider: { name: "WoCo", url: "https://woco-net.com" },
    capabilities: [
      { name: "discover_events", description: "List WoCo events; filter by organiser." },
      { name: "price_ticket", description: "Get the exact USDC amount + organiser recipient for a ticket series." },
      { name: "buy_ticket", description: "Settle a ticket purchase from a granted spend-permission budget." },
    ],
    payment: {
      protocol: "x402",
      scheme: "spend-permission",
      description:
        "x402-style 402 handshake; settled by a draw against an ERC-7710/ZeroDev spend " +
        "permission (non-custodial) rather than an EIP-3009 hot-wallet transfer.",
      asset: "USDC",
      network: "eip155:421614",
      chain: "Arbitrum Sepolia",
      bounds: ["recipient-pinned", "per-draw ceiling", "expiry", "max draw count"],
    },
    endpoints: {
      events: `${base}/api/agent/events`,
      eventDetail: `${base}/api/agent/events/{eventId}`,
      grantParams: `${base}/api/agent/grant-params`,
      quote: `${base}/api/agent/quote`,
      buy: `${base}/api/agent/buy`,
    },
    openapi: `${base}/api/agent/openapi.json`,
    mcp: `${base}/mcp`,
  };
}

/** OpenAPI 3.1 description of the /api/agent/* surface. */
export function agentOpenApi(base: string = agentBaseUrl()) {
  return {
    openapi: "3.1.0",
    info: {
      title: "WoCo Events Agent API",
      version: "0.1.0",
      description:
        "Autonomous ticket commerce. Discover events, price a ticket in USDC, and buy it " +
        "by drawing against a non-custodial spend permission (Arbitrum Sepolia).",
    },
    servers: [{ url: base }],
    paths: {
      "/api/agent/events": {
        get: {
          operationId: "discoverEvents",
          summary: "List events (optionally filtered by organiser).",
          parameters: [
            {
              name: "organiser",
              in: "query",
              required: false,
              schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
            },
          ],
          responses: { "200": { description: "Event directory entries." } },
        },
      },
      "/api/agent/events/{eventId}": {
        get: {
          operationId: "getEvent",
          summary: "Event detail with series + USDC pricing.",
          parameters: [{ name: "eventId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Event detail." }, "404": { description: "Not found." } },
        },
      },
      "/api/agent/grant-params": {
        post: {
          operationId: "grantParams",
          summary: "Server-dictated bounds to embed in the spend-permission approval.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["agentAddress", "eventId"],
                  properties: {
                    agentAddress: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
                    eventId: { type: "string" },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "AgentBudgetParams." } },
        },
      },
      "/api/agent/quote": {
        post: {
          operationId: "quoteTicket",
          summary: "Exact USDC amount + organiser recipient for a series.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["eventId", "seriesId"],
                  properties: { eventId: { type: "string" }, seriesId: { type: "string" } },
                },
              },
            },
          },
          responses: { "200": { description: "Quote (amountAtomic, recipient, usdcAddress, chainId)." } },
        },
      },
      "/api/agent/buy": {
        post: {
          operationId: "buyTicket",
          summary: "Settle a purchase. 402 without a draw; mints with one.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["eventId", "seriesId"],
                  properties: {
                    eventId: { type: "string" },
                    seriesId: { type: "string" },
                    userKernel: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
                    settlementTxHash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Ticket minted." },
            "402": { description: "Payment required — pay (draw) then retry." },
          },
        },
      },
    },
  };
}
