/**
 * EventAnnouncement type definition for event discovery.
 *
 * This interface defines the shape of event announcement messages used for
 * real-time discovery. Currently dormant — retained as the contract for when
 * a real-time transport (WebSocket, SSE, Waku) is implemented.
 *
 * Protobuf field IDs are preserved in comments for future Waku re-integration.
 */
import type { WakuAnnounceAction } from "./constants.js";

export interface EventAnnouncement {
  eventId: string;            // proto id: 1
  title: string;              // proto id: 2
  imageHash: string;          // proto id: 3
  startDate: string;          // proto id: 4
  location: string;           // proto id: 5
  creatorAddress: string;     // proto id: 6
  seriesCount: number;        // proto id: 7
  totalTickets: number;       // proto id: 8
  createdAt: string;          // proto id: 9
  /** Organiser's self-hosted API URL (empty string if using WoCo's server) */
  apiUrl: string;             // proto id: 10
  /** ISO 8601 timestamp of this announcement */
  announcedAt: string;        // proto id: 11
  /** "created" | "listed" | "unlisted" */
  action: WakuAnnounceAction; // proto id: 12
  /** Event category (e.g. "conference", "music", "art") */
  category: string;           // proto id: 13
  /** Searchable tags */
  tags: string[];             // proto id: 14
  /** Geographic region (e.g. "europe", "asia", city name) */
  region: string;             // proto id: 15
  /** Swarm content reference — clients can fetch event data directly from Swarm */
  swarmRef: string;           // proto id: 16
}
