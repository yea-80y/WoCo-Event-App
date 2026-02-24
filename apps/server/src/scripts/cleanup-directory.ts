/**
 * One-off script: remove test events (2099 dates) from the event directory feed.
 * Run on server: npx tsx src/scripts/cleanup-directory.ts
 */
import "dotenv/config";
import { readFeedPage, writeFeedPage, encodeJsonFeed, decodeJsonFeed } from "../lib/swarm/feeds.js";
import { topicEventDirectory } from "../lib/swarm/topics.js";
import type { EventDirectoryEntry } from "@woco/shared";

interface EventDirectory {
  v: 1;
  entries: EventDirectoryEntry[];
  updatedAt: string;
}

async function main() {
  console.log("Reading current event directory...");
  const page = await readFeedPage(topicEventDirectory());
  if (!page) {
    console.log("Directory feed is empty — nothing to do.");
    return;
  }

  const dir = decodeJsonFeed<EventDirectory>(page);
  if (!dir) {
    console.log("Could not decode directory — aborting.");
    return;
  }

  console.log(`Current entries (${dir.entries.length}):`);
  for (const e of dir.entries) {
    console.log(`  [${e.startDate}] ${e.title} (${e.eventId})`);
  }

  const cleaned = dir.entries.filter((e) => !e.startDate.startsWith("2099"));
  const removed = dir.entries.filter((e) => e.startDate.startsWith("2099"));

  console.log(`\nRemoving ${removed.length} test event(s):`);
  for (const e of removed) {
    console.log(`  - ${e.title}`);
  }

  const updated: EventDirectory = {
    v: 1,
    entries: cleaned,
    updatedAt: new Date().toISOString(),
  };

  await writeFeedPage(topicEventDirectory(), encodeJsonFeed(updated));
  console.log(`\nDone. Directory now has ${cleaned.length} event(s).`);
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
