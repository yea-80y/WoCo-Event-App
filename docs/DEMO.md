# Demo — Autonomous Agent Commerce

A ~1-minute screen recording of an AI agent **buying an event ticket on its own**, paying in USDC on
Arbitrum Sepolia — without ever holding the user's funds.

**▶ Watch:** [Release v0.1-buildathon](https://github.com/yea-80y/WoCo-Event-App/releases/tag/v0.1-buildathon)
· direct link: [`agent.demo.mp4`](https://github.com/yea-80y/WoCo-Event-App/releases/download/v0.1-buildathon/agent.demo.mp4)

<!-- GitHub renders this Release-asset link as an inline player in the rendered file: -->
https://github.com/yea-80y/WoCo-Event-App/releases/download/v0.1-buildathon/agent.demo.mp4

## What's happening

The user grants a **bounded, non-custodial spend permission**: USDC stays in the user's own smart
account, and the agent gets a capped, time-boxed authorization to spend up to a set limit. In the
clip, the agent (via MCP tools) discovers the event, fetches a signed price quote, then draws exactly
the quoted **$1 USDC** with **its own key** and settles the purchase — minting the ticket directly to
the user. The agent can never exceed the on-chain cap or redirect funds: off-policy draws (e.g. a
wrong recipient) are rejected by the account's call policy.

1. Agent calls `find_events` → `get_quote` → `buy_ticket` (no human signing per purchase)
2. A bounded spend permission draws $1 USDC, agent-signed, on Arbitrum Sepolia
3. The ticket mints to the user; the on-chain draw is verifiable on Arbiscan

## Verify on-chain

- **Draw tx:** [`0x0e8e688f…`](https://sepolia.arbiscan.io/tx/0x0e8e688ffdc0e3d686b35beb36eae72f3b8b0d964c9744992be107941c0c44f1)
- Full design + verified-tx table: [AGENT_COMMERCE_SURFACE.md](AGENT_COMMERCE_SURFACE.md)

## Stack

ZeroDev Kernel smart accounts + bounded spend permissions · USDC (Arbitrum Sepolia `421614`) · MCP
agent surface.
