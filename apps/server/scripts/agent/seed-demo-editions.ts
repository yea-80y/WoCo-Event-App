/**
 * Seed the agent-demo series' EDITIONS feed so the Swarm-editions claim path
 * (`claimTicket`) can mint a ticket when the agent settles.
 *
 * WHY THIS EXISTS: `setup-demo-event.ts` writes only the event feed + directory
 * entry. The legacy Swarm-editions claim path that `settleAgentTicketPurchase →
 * claimTicket` uses additionally needs `woco/pod/editions/{seriesId}` page 0 =
 * [metaRef, ticketRef1…N], where each ticketRef is a `woco.ticket.v1` POD with a
 * valid ed25519 self-signature. Real organiser publishes build these client-side;
 * for the headless demo we generate them here with a throwaway POD key (claim
 * only checks each ticket's signature against its OWN embedded pubkey, so any
 * key produces claimable editions). Idempotent: no-op if the feed already exists.
 *
 * Run (dev bee tunnel must be up — e.g. `npm run dev:server` in another shell):
 *   node --import tsx apps/server/scripts/agent/seed-demo-editions.ts
 */

import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex } from "@noble/hashes/utils";
import { uploadToBytes } from "../../src/lib/swarm/bytes.js";
import { writeFeedPage, pack4096, readFeedPage } from "../../src/lib/swarm/feeds.js";
import { topicEditions } from "../../src/lib/swarm/topics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "../../.env") });

const EVENT_ID = process.env.AGENT_DEMO_EVENT_ID || "agent-demo-event-01";
const SERIES_ID = process.env.AGENT_DEMO_SERIES_ID || "agent-demo-series-01";
const SERIES_NAME = "Agent Demo Ticket";
const CREATOR = "0x7b318c46a6fdc544212ebd83335f6b7414a97925";
const IMAGE_HASH = "0000000000000000000000000000000000000000000000000000000000000000";
/** Editions to seed. Plenty for the demo's one purchase + reruns; one Swarm
 *  upload each, so kept modest to stay quick over the tunnel. */
const SUPPLY = 20;

async function main() {
  console.log(`Seeding editions for ${SERIES_ID} (${SUPPLY} editions)…`);

  const existing = await readFeedPage(topicEditions(SERIES_ID, 0)).catch(() => null);
  if (existing) {
    console.log("Editions feed already exists — nothing to do (idempotent).");
    return;
  }

  // Throwaway POD key — each ticket self-verifies against its embedded pubkey.
  const podPriv = ed25519.utils.randomPrivateKey();
  const podPub = ed25519.getPublicKey(podPriv);
  const publicKey = bytesToHex(podPub);
  const mintedAt = new Date().toISOString();

  // metadata page-0 slot 0 — what loadSeriesMeta parses.
  const metaRef = await uploadToBytes(
    JSON.stringify({ totalSupply: SUPPLY, pageCount: 1, approvalRequired: false }),
  );

  const ticketRefs: string[] = [];
  for (let edition = 1; edition <= SUPPLY; edition++) {
    const data = {
      podType: "woco.ticket.v1" as const,
      eventId: EVENT_ID,
      seriesId: SERIES_ID,
      seriesName: SERIES_NAME,
      edition,
      totalSupply: SUPPLY,
      imageHash: IMAGE_HASH,
      creator: CREATOR,
      mintedAt,
    };
    const signature = bytesToHex(ed25519.sign(new TextEncoder().encode(JSON.stringify(data)), podPriv));
    const ref = await uploadToBytes(JSON.stringify({ data, signature, publicKey }));
    ticketRefs.push(ref);
    process.stdout.write(`\r  uploaded edition ${edition}/${SUPPLY}`);
  }
  process.stdout.write("\n");

  // Page 0: [metaRef, ticketRef1 … ticketRefN]. Slot index = edition number.
  // MIGRATION SEAM (client-side feed signing): ticket PODs above are already
  // signed with an off-server key (the organiser-client model). Only this feed
  // WRITE still uses the server signer (FEED_PRIVATE_KEY via writeFeedPage). When
  // feed signing moves client-side, swap just this call for a client feed write
  // of the same `pack4096(...)` page to `topicEditions(SERIES_ID, 0)` — the
  // page-building + ticket-signing above is unchanged.
  await writeFeedPage(topicEditions(SERIES_ID, 0), pack4096([metaRef, ...ticketRefs]), { fresh: true });
  console.log(`  editions feed written (meta=${metaRef.slice(0, 12)}…, ${SUPPLY} editions).`);
  console.log("Done — the agent demo can now mint.");
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});
