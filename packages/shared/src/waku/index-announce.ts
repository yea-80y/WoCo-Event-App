/**
 * IndexAnnouncement protobuf schema for Waku decentralised discovery.
 *
 * Any server/node can announce that it maintains an event index on Swarm.
 * Clients discover index providers via this topic, fetch their Swarm feeds,
 * and merge multiple independent indexes into a decentralised directory.
 *
 * Published to WAKU_INDEX_ANNOUNCE_TOPIC on:
 * - Server startup
 * - Periodically (e.g. every hour) to stay visible in the 48h Store window
 */
import protobuf from "protobufjs/light.js";

// ---------------------------------------------------------------------------
// Static protobuf descriptor
// ---------------------------------------------------------------------------

const root = protobuf.Root.fromJSON({
  nested: {
    IndexAnnouncement: {
      fields: {
        maintainer:         { id: 1,  type: "string" },
        swarmFeedTopic:     { id: 2,  type: "string" },
        swarmSignerAddress: { id: 3,  type: "string" },
        eventCount:         { id: 4,  type: "uint32" },
        categories:         { id: 5,  type: "string", rule: "repeated" },
        region:             { id: 6,  type: "string" },
        updatedAt:          { id: 7,  type: "string" },
        apiUrl:             { id: 8,  type: "string" },
      },
    },
  },
});

const IndexAnnouncementType = root.lookupType("IndexAnnouncement");

// ---------------------------------------------------------------------------
// TypeScript interface
// ---------------------------------------------------------------------------

export interface IndexAnnouncement {
  /** Eth address of the index maintainer */
  maintainer: string;
  /** Swarm feed topic string for this index (e.g. "woco/event/directory") */
  swarmFeedTopic: string;
  /** Swarm feed signer's Ethereum address (needed to read the feed) */
  swarmSignerAddress: string;
  /** Number of events in this index */
  eventCount: number;
  /** Categories this index covers */
  categories: string[];
  /** Geographic region this index covers (empty = global) */
  region: string;
  /** ISO 8601 timestamp of last index update */
  updatedAt: string;
  /** API URL for fetching event data (optional — clients can also read Swarm directly) */
  apiUrl: string;
}

// ---------------------------------------------------------------------------
// Encode / Decode
// ---------------------------------------------------------------------------

export function encodeIndexAnnouncement(msg: IndexAnnouncement): Uint8Array {
  const errMsg = IndexAnnouncementType.verify(msg);
  if (errMsg) throw new Error(`Invalid IndexAnnouncement: ${errMsg}`);
  return IndexAnnouncementType.encode(
    IndexAnnouncementType.create(msg),
  ).finish();
}

export function decodeIndexAnnouncement(
  data: Uint8Array,
): IndexAnnouncement | null {
  try {
    const decoded = IndexAnnouncementType.decode(data);
    const obj = IndexAnnouncementType.toObject(decoded, {
      defaults: true,
      arrays: true,
      longs: Number,
    }) as IndexAnnouncement;
    if (!obj.maintainer || !obj.swarmFeedTopic) return null;
    return obj;
  } catch {
    return null;
  }
}
