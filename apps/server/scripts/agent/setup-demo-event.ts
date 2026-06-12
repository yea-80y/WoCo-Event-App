/**
 * One-time setup: creates a minimal WoCo event with a USDC/direct-transfer
 * series accepting chain 421614 (Arbitrum Sepolia) and publishes it to Swarm.
 *
 * Also generates a fresh demo-user private key and derives its ZeroDev Kernel
 * address so you can fund it with Circle test USDC before running the demo.
 *
 * Prerequisites: dev bee tunnel must be running (npm run dev:server already
 * does this; or start it separately and kill the server, keeping the tunnel).
 *
 * Run (from repo root):
 *   node --env-file=apps/server/.env --import tsx apps/server/scripts/agent/setup-demo-event.ts
 *
 * Output: the four env vars to paste into apps/server/.env, then run the demo.
 */

import { fileURLToPath } from "url";
import { dirname } from "path";
import { generatePrivateKey } from "viem/accounts";
import { writeFeedPage, encodeJsonFeed, readFeedPage } from "../../src/lib/swarm/feeds.js";
import { addEventToDirectory } from "../../src/lib/event/service.js";
import { topicEvent } from "../../src/lib/swarm/topics.js";
import { buildKernelFromPrivateKey, addressFromPrivateKey } from "./zerodev.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Demo event identity ──────────────────────────────────────────────────────

// Deterministic IDs so re-running this script is idempotent (same Swarm feed).
const EVENT_ID   = "agent-demo-event-01";
const SERIES_ID  = "agent-demo-series-01";

// Organiser = sponsor address (we control this key; USDC lands here in the demo).
// Value of WOCO_SPONSOR_PRIVATE_KEY → address 0x7b318c46…
const ORGANISER: `0x${string}` = "0x7b318c46a6fdc544212ebd83335f6b7414a97925";

// USDC on Arb Sepolia (Circle test USDC — same surface as mainnet).
const USDC_421614: `0x${string}` = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";

// ── Build event feed ─────────────────────────────────────────────────────────

const now = new Date();
const startDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
const endDate   = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

const eventFeed = {
  v: 1,
  eventId: EVENT_ID,
  title: "WoCo Agent Commerce Demo",
  description: "Demo event for the bounded non-custodial agent wallet (Arbitrum Sepolia).",
  // Placeholder image hash — 64-char zeroes is a valid Swarm ref (resolves to nothing, fine for a demo).
  imageHash: "0000000000000000000000000000000000000000000000000000000000000000",
  startDate,
  endDate,
  location: "Arbitrum Sepolia",
  creatorAddress: ORGANISER,
  creatorPodKey: "demo",
  createdAt: new Date().toISOString(),
  claimMode: "wallet",
  series: [
    {
      seriesId: SERIES_ID,
      name: "Agent Demo Ticket",
      description: "Purchased autonomously by an AI agent via a bounded spend permission.",
      totalSupply: 100,
      price: 1,
      payment: {
        price: "1",
        currency: "USD",
        recipientAddress: ORGANISER,
        acceptedChains: [421614],
        escrow: false,
        cryptoEnabled: true,
        stripeEnabled: false,
      },
    },
  ],
};

// ── Write to Swarm ────────────────────────────────────────────────────────────

async function main() {
  console.log("━━━ WoCo Agent Demo Setup ━━━\n");

  // 1. Generate a fresh demo-user private key.
  const userPk = generatePrivateKey();
  console.log("Generated demo user private key (save this):");
  console.log(`  AGENT_DEMO_USER_PK=${userPk}\n`);

  // 2. Derive the ZeroDev Kernel address so the user can fund it.
  console.log("Deriving ZeroDev Kernel address (takes a few seconds)…");
  const user = await buildKernelFromPrivateKey(userPk);
  console.log(`  Kernel address: ${user.address}`);
  console.log(`  → Fund this address with Circle test USDC on Arb Sepolia:`);
  console.log(`    https://faucet.circle.com  (select Arbitrum Sepolia, token USDC)\n`);

  // 3. Check if event already exists.
  const existing = await readFeedPage(topicEvent(EVENT_ID)).catch(() => null);
  if (existing) {
    console.log("Event feed already exists on Swarm — skipping write (idempotent).\n");
  } else {
    // 4. Write event feed to Swarm.
    console.log("Writing event feed to Swarm…");
    await writeFeedPage(topicEvent(EVENT_ID), encodeJsonFeed(eventFeed), { fresh: true });
    console.log("  event feed written.\n");

    // 5. Add to the global events directory.
    console.log("Adding to event directory…");
    await addEventToDirectory(
      {
        eventId: EVENT_ID,
        title: eventFeed.title,
        imageHash: eventFeed.imageHash as any,
        startDate: eventFeed.startDate,
        endDate: eventFeed.endDate,
        location: eventFeed.location,
        creatorAddress: ORGANISER,
        seriesCount: 1,
        totalTickets: 100,
        createdAt: eventFeed.createdAt,
      },
      { skipPublicDirectory: false },
    );
    console.log("  directory updated.\n");
  }

  // 6. Print the env vars to set.
  console.log("━━━ Add these to apps/server/.env ━━━\n");
  console.log(`AGENT_API_BASE=http://localhost:3001`);
  console.log(`AGENT_DEMO_USER_PK=${userPk}`);
  console.log(`AGENT_DEMO_EVENT_ID=${EVENT_ID}`);
  console.log(`AGENT_DEMO_SERIES_ID=${SERIES_ID}`);
  console.log(`\n(Organiser recipient for USDC: ${ORGANISER})`);
  console.log(`(User Kernel to fund:          ${user.address})`);
  console.log("\nThen fund the Kernel with ~$2 of Circle test USDC, restart the");
  console.log("dev server, and run: npm run agent:demo -w @woco/server\n");
  console.log("━━━ done ━━━");
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});
