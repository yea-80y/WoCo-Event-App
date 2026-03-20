# Waku Decentralized Event Discovery

WoCo uses the [Waku](https://waku.org/) protocol for decentralized event discovery alongside the Swarm directory. Waku provides real-time event announcements that supplement the authoritative Swarm feed-based directory.

## Architecture

```
                          ┌──────────────┐
              ┌──────────►│  nwaku Relay  │◄──────────┐
              │           │  (your node)  │           │
              │           └──────┬────────┘           │
              │                  │                    │
         LightPush          Filter/Store          Filter/Store
         Filter/Store           │                    │
              │                 │                    │
       ┌──────┴───────┐   ┌────▼─────┐        ┌─────▼─────┐
       │  WoCo Server │   │ Browser  │        │ Browser   │
       │  (Swarm +    │   │ (light   │  ...   │ (light    │
       │   publish)   │   │  node)   │        │  node)    │
       └──────────────┘   └──────────┘        └───────────┘
```

- **Browser** connects directly to nwaku as a Waku light node peer
  - Filter subscription: real-time event announcements (instant)
  - Store query: historical announcements (last 48h on startup)
- **Server** also connects as a Waku peer: publishes via LightPush, subscribes via Filter
  - `GET /api/events` merges Swarm directory + Waku discoveries server-side
- **nwaku relay node** receives, stores (48h), relays messages, serves all light clients
- **Swarm** stores the actual event data; Waku carries lightweight announcements

### Why browser-direct?

Every client is a Waku peer. No server intermediary for discovery. This means:
- Events appear instantly in the browser (Filter subscription, no polling)
- Discovery works even if the WoCo API server is down
- Migration to public Waku network requires zero frontend changes
- The server is only needed for Swarm writes and the REST API

## Components

### nwaku Relay Node (`nwaku/docker-compose.yml`)

Self-hosted [nwaku](https://github.com/waku-org/nwaku) relay node running on the Ubuntu server (192.168.0.144). Provides:

- **Relay**: propagates messages to the wider Waku network
- **Filter**: serves real-time subscriptions to the server's light node
- **LightPush**: accepts messages from the WoCo server
- **Store**: persists messages for 48 hours for historical queries

Configuration:
- Cluster ID: 42 (custom, avoids TWN RLN requirements)
- Single shard: 0
- Ports: 60000 (TCP libp2p), 8546 (WebSocket), 8645 (REST API)
- Image: `wakuorg/nwaku:v0.36.0`

### Server Waku Client (`apps/server/src/lib/waku/client.ts`)

Singleton light node. Lazy-initialized on first use.

- Gated by `WAKU_ENABLED=true` env var
- Connects to nwaku via WebSocket using `WAKU_BOOTSTRAP_PEERS` env var
- Uses `libp2p: { filterMultiaddrs: false }` to allow plain `ws://` (not just `wss://`)
- Includes `Promise.withResolvers` polyfill for Node < 22
- Falls back to public Waku bootstrap if env var is not set

### Server Discovery Service (`apps/server/src/lib/waku/discovery.ts`)

Subscribes to Waku for event announcements:

1. Queries Store for the last 48h of historical announcements
2. Subscribes via Filter for real-time announcements
3. Maintains in-memory Map of discovered events
4. Exposes `getWakuDiscoveredEvents()` for the API endpoint

### Server Announcement Publisher (`apps/server/src/lib/waku/announce.ts`)

Publishes event announcements via LightPush when events are created, listed, or unlisted.

### API Endpoint (`GET /api/events/waku-discovered`)

Returns all Waku-discovered events as JSON. Used by the browser's polling client.

### Browser Waku Client (`apps/web/src/lib/waku/client.ts`)

Singleton light node running in the browser. Connects directly to nwaku via WebSocket.
Dynamic import avoids loading the Waku SDK (~500KB) until the home page mounts.

### Browser Discovery (`apps/web/src/lib/waku/discovery.svelte.ts`)

Svelte 5 rune-based reactive store that:

1. Connects to nwaku directly (browser is a Waku light node peer)
2. Queries Store for 48h of historical announcements on startup
3. Subscribes via Filter for real-time announcements (events appear instantly)
4. Provides `mergeWithLive()` to layer live events on top of fetched data
5. Components use `$derived(mergeWithLive(fetchedEvents))` for reactive updates

### Shared Protocol (`packages/shared/src/waku/`)

- `constants.ts`: Content topic (`/woco/1/event-announce/proto`), cluster ID (42), shard index (0)
- `event-announce.ts`: Protobuf encoding/decoding for `EventAnnouncement` messages

## Connection Details

**Key insight**: `@waku/sdk` only supports **WebSocket** transport (not TCP). The multiaddr must use the `/ws` protocol segment. Additionally, the SDK defaults to `wss://` only — for plain `ws://` connections (self-hosted, no TLS), set `libp2p: { filterMultiaddrs: false }`.

Correct multiaddr format: `/ip4/<IP>/tcp/<WS_PORT>/ws/p2p/<PEER_ID>`

## Message Format

Announcements are Protobuf-encoded with the following schema:

| Field           | Type   | Description                       |
|-----------------|--------|-----------------------------------|
| eventId         | string | Unique event identifier           |
| title           | string | Event title                       |
| imageHash       | string | Swarm hash of event image         |
| startDate       | string | ISO 8601 date string              |
| location        | string | Event location                    |
| creatorAddress  | string | Organizer's Ethereum address      |
| seriesCount     | uint32 | Number of ticket series           |
| totalTickets    | uint32 | Total tickets across all series   |
| createdAt       | string | ISO 8601 creation timestamp       |
| apiUrl          | string | API server URL (for external events) |
| announcedAt     | string | ISO 8601 announcement timestamp   |
| action          | string | "created", "listed", or "unlisted" |

## Environment Variables

### Server (`apps/server/.env`)

```env
# Enable Waku publishing + discovery
WAKU_ENABLED=true

# nwaku WebSocket multiaddr (get peer ID from: curl http://192.168.0.144:8645/debug/v1/info)
WAKU_BOOTSTRAP_PEERS=/ip4/192.168.0.144/tcp/8546/ws/p2p/<PEER_ID>
```

## Operations

### Starting the nwaku node

```bash
ssh ntl-dev@192.168.0.144
cd ~/nwaku
docker compose up -d
```

### Checking nwaku status

```bash
# Logs
docker logs nwaku-nwaku-1 --tail 20

# REST API — node info + peer ID
curl http://192.168.0.144:8645/debug/v1/info

# Connected peers
curl http://192.168.0.144:8645/admin/v1/peers
```

### Getting the peer ID

```bash
curl -s http://192.168.0.144:8645/debug/v1/info | jq -r '.listenAddresses[0]'
```

The peer ID is the last segment after `/p2p/`.

### Restarting nwaku

```bash
cd ~/nwaku
docker compose down
docker compose up -d
```

**Note**: The peer ID changes if the volume is removed (`docker volume rm nwaku_nwaku-data`). Update the bootstrap peer multiaddr in the server `.env` if this happens.

## Role of Swarm vs Waku

Swarm and Waku serve complementary purposes:

| | Swarm | Waku |
|---|---|---|
| **Purpose** | Persistent storage (source of truth) | Real-time messaging + discovery |
| **Data** | Full event data, tickets, feeds | Lightweight announcements (metadata only) |
| **Latency** | Slower (feed writes, propagation) | Near-instant (pubsub) |
| **Durability** | Permanent (paid via postage) | Ephemeral (48h store, then gone) |
| **Trust model** | Verifiable (content-addressed) | Announced but unverified |

**Current flow**: Waku announces events after the event feed is verified on Swarm. Browsers subscribe directly to nwaku via Filter and see new events instantly. `GET /api/events` also merges Swarm + Waku server-side as a fallback for initial page load.

**Will we always need the Swarm directory?** Yes, but its role will shift. Today it's the primary listing; Waku supplements it. Long-term, Waku becomes the primary discovery channel, with the Swarm directory serving as a durable backup and verification layer for clients that weren't online when the announcement was broadcast.

## Waku Roadmap

### Phase 1: Real-time Event Discovery (DONE)

- Server publishes announcements via LightPush on create/list/unlist
- Browser connects directly to nwaku as a light node peer (no server intermediary)
- Browser subscribes via Filter (real-time) and queries Store (48h history)
- Events appear instantly in the UI — no polling delay
- `GET /api/events` also merges Swarm + Waku server-side (fallback for initial load)
- Waku fires after event feed is verified on Swarm — ensures discoverable events are loadable

### Phase 2: Cross-Server Discovery (NEXT)

Multiple self-hosted WoCo servers (e.g., different organisers) each run their own nwaku node on the same cluster. Events created on Server A are automatically discovered by Server B via Waku, without manual import.

- Each organiser's server announces events with their `apiUrl`
- Receiving servers validate announcements (check the event feed exists on the announced apiUrl)
- The existing discover/import flow becomes automatic via Waku instead of manual URL entry

### Phase 3: Decentralized Indexing via Waku

Waku can replace or supplement the Swarm-based event directory as an index:

- **Category/tag announcements**: Events announce their category, date range, location — receivers build local indexes without reading every Swarm feed
- **Search without a central index**: Each WoCo server maintains its own index from Waku messages. No single server owns the global directory.
- **Claim activity signals**: Lightweight Waku messages like "event X is trending" (N claims in last hour) help surface popular events without polling Swarm feeds
- **Organiser reputation index**: Aggregate announcement history per creator address — how many events, how recent, verified vs unverified

The key insight: Waku messages are cheap and fast. Use them to build local indexes that would be expensive to maintain on Swarm (which charges per write and is slow to update). Swarm stores the actual data; Waku tells you what data exists and where to find it.

### Phase 4: Public Network Migration

Move from custom cluster 42 to the public Waku network (TWN):

- Evaluate RLN rate-limiting requirements and costs
- Update cluster ID and bootstrap peers
- Events become discoverable by any Waku peer globally, not just WoCo's nwaku node
- Browser-direct architecture means this is a config change, not a code change

### Phase 5: Ticket Activity Channel

Beyond discovery, Waku can carry real-time ticket activity:

- **Claim notifications**: "Your event just got a new attendee" (organiser push)
- **Capacity updates**: "Only 5 tickets left" broadcast to all interested clients
- **Approval flow**: Pending claim requests and approvals as Waku messages (faster than polling Swarm feeds)
- **Check-in signals**: Real-time door check-in status at live events

## Centralization & Mitigation

The nwaku node is a centralization point (similar to the Swarm gateway). Mitigation paths:

1. **Multiple relay nodes**: Run 2-3 for redundancy; light clients can list multiple bootstrap peers
2. **Community nodes**: Other WoCo users can run their own nwaku nodes on cluster 42
3. **Browser direct connect**: Remove the server-as-gateway bottleneck entirely (Phase 4)
4. **Public network migration**: As the Waku network matures and RLN becomes accessible, move from custom cluster 42 to the public TWN

The architecture is designed so that if Waku is unavailable, the app works exactly as before using only the Swarm directory.
