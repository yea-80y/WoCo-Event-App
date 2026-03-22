/**
 * IndexAnnouncement type definition for decentralised discovery.
 *
 * Any server/node can announce that it maintains an event index on Swarm.
 * Clients discover index providers, fetch their Swarm feeds, and merge
 * multiple independent indexes into a decentralised directory.
 *
 * Currently dormant — retained as the contract for when a real-time
 * transport is implemented. Protobuf field IDs preserved in comments.
 */

export interface IndexAnnouncement {
  /** Eth address of the index maintainer */
  maintainer: string;               // proto id: 1
  /** Swarm feed topic string for this index (e.g. "woco/event/directory") */
  swarmFeedTopic: string;           // proto id: 2
  /** Swarm feed signer's Ethereum address (needed to read the feed) */
  swarmSignerAddress: string;       // proto id: 3
  /** Number of events in this index */
  eventCount: number;               // proto id: 4
  /** Categories this index covers */
  categories: string[];             // proto id: 5
  /** Geographic region this index covers (empty = global) */
  region: string;                   // proto id: 6
  /** ISO 8601 timestamp of last index update */
  updatedAt: string;                // proto id: 7
  /** API URL for fetching event data (optional — clients can also read Swarm directly) */
  apiUrl: string;                   // proto id: 8
}
