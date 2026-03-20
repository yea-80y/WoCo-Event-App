/**
 * EventCatalog protobuf schema for Waku discovery.
 *
 * The server periodically publishes the full event directory as a catalog
 * message. Any browser connecting at any time can query Store for the latest
 * catalog and immediately know about ALL events — not just those created in
 * the last 48 hours.
 *
 * Published to WAKU_CATALOG_TOPIC on:
 * - Server startup (after Waku connects)
 * - After event create/list/unlist (directory changed)
 * - Periodically (every 30 minutes) to keep Store fresh
 */
import protobuf from "protobufjs/light.js";

// ---------------------------------------------------------------------------
// Static protobuf descriptor
// ---------------------------------------------------------------------------

const root = protobuf.Root.fromJSON({
  nested: {
    CatalogEntry: {
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
      },
    },
    EventCatalog: {
      fields: {
        publishedAt: { id: 1, type: "string" },
        entries:     { id: 2, type: "CatalogEntry", rule: "repeated" },
      },
    },
  },
});

const EventCatalogType = root.lookupType("EventCatalog");

// ---------------------------------------------------------------------------
// TypeScript interfaces
// ---------------------------------------------------------------------------

export interface CatalogEntry {
  eventId: string;
  title: string;
  imageHash: string;
  startDate: string;
  location: string;
  creatorAddress: string;
  seriesCount: number;
  totalTickets: number;
  createdAt: string;
  apiUrl: string;
}

export interface EventCatalog {
  publishedAt: string;
  entries: CatalogEntry[];
}

// ---------------------------------------------------------------------------
// Encode / Decode
// ---------------------------------------------------------------------------

export function encodeEventCatalog(catalog: EventCatalog): Uint8Array {
  const errMsg = EventCatalogType.verify(catalog);
  if (errMsg) throw new Error(`Invalid EventCatalog: ${errMsg}`);
  return EventCatalogType.encode(
    EventCatalogType.create(catalog),
  ).finish();
}

export function decodeEventCatalog(data: Uint8Array): EventCatalog | null {
  try {
    const decoded = EventCatalogType.decode(data);
    const obj = EventCatalogType.toObject(decoded, {
      defaults: true,
      arrays: true,
      longs: Number,
    }) as EventCatalog;
    if (!obj.publishedAt) return null;
    return obj;
  } catch {
    return null;
  }
}
