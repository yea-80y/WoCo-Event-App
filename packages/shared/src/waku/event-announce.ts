/**
 * EventAnnouncement protobuf schema for Waku discovery.
 *
 * Uses protobufjs/light with a static JSON descriptor — no runtime .proto
 * parsing, small bundle footprint (~20KB).
 *
 * This message is published to WAKU_CONTENT_TOPIC when:
 * - An event is created (action = "created")
 * - An event is listed on the WoCo directory (action = "listed")
 * - An event is unlisted from the WoCo directory (action = "unlisted")
 *
 * Frontends subscribe to the topic and merge announcements with the
 * Swarm directory feed for decentralized event discovery.
 */
import protobuf from "protobufjs/light.js";
import type { WakuAnnounceAction } from "./constants.js";

// ---------------------------------------------------------------------------
// Static protobuf descriptor (equivalent to .proto file)
// ---------------------------------------------------------------------------

const root = protobuf.Root.fromJSON({
  nested: {
    EventAnnouncement: {
      fields: {
        eventId:        { id: 1,  type: "string" },
        title:          { id: 2,  type: "string" },
        imageHash:      { id: 3,  type: "string" },
        startDate:      { id: 4,  type: "string" },
        location:       { id: 5,  type: "string" },
        creatorAddress: { id: 6,  type: "string" },
        seriesCount:    { id: 7,  type: "uint32" },
        totalTickets:   { id: 8,  type: "uint32" },
        createdAt:      { id: 9,  type: "string" },
        apiUrl:         { id: 10, type: "string" },
        announcedAt:    { id: 11, type: "string" },
        action:         { id: 12, type: "string" },
      },
    },
  },
});

const EventAnnouncementType = root.lookupType("EventAnnouncement");

// ---------------------------------------------------------------------------
// TypeScript interface (mirrors the protobuf fields)
// ---------------------------------------------------------------------------

export interface EventAnnouncement {
  eventId: string;
  title: string;
  imageHash: string;
  startDate: string;
  location: string;
  creatorAddress: string;
  seriesCount: number;
  totalTickets: number;
  createdAt: string;
  /** Organiser's self-hosted API URL (empty string if using WoCo's server) */
  apiUrl: string;
  /** ISO 8601 timestamp of this announcement */
  announcedAt: string;
  /** "created" | "listed" | "unlisted" */
  action: WakuAnnounceAction;
}

// ---------------------------------------------------------------------------
// Encode / Decode
// ---------------------------------------------------------------------------

/** Encode an EventAnnouncement to a Uint8Array for Waku transmission. */
export function encodeEventAnnouncement(msg: EventAnnouncement): Uint8Array {
  const errMsg = EventAnnouncementType.verify(msg);
  if (errMsg) throw new Error(`Invalid EventAnnouncement: ${errMsg}`);
  return EventAnnouncementType.encode(
    EventAnnouncementType.create(msg),
  ).finish();
}

/** Decode a Uint8Array from Waku into an EventAnnouncement. Returns null on invalid data. */
export function decodeEventAnnouncement(
  data: Uint8Array,
): EventAnnouncement | null {
  try {
    const decoded = EventAnnouncementType.decode(data);
    const obj = EventAnnouncementType.toObject(decoded, {
      defaults: true,
      longs: Number,
    }) as EventAnnouncement;
    // Minimal validation
    if (!obj.eventId || !obj.action) return null;
    return obj;
  } catch {
    return null;
  }
}
