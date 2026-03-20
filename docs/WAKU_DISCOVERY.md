# Waku Decentralized Event Discovery

WoCo uses the [Waku](https://waku.org/) protocol for decentralized event discovery alongside the Swarm directory. Waku provides real-time event announcements that supplement the authoritative Swarm feed-based directory.

## Architecture

```
┌──────────────┐     LightPush/Filter/Store      ┌──────────────┐
│  WoCo Server │ ◄──────────────────────────────► │  nwaku Relay  │
│  (gateway)   │         WebSocket (ws)           │  (your node)  │
└──────┬───────┘                                  └──────────────┘
       │                                                │
  GET /api/events/                                Relay gossip
   waku-discovered                                      │
       │                                          ┌─────▼─────┐
┌──────▼───────┐                                  │  Public    │
│   Browser    │                                  │  Waku Net  │
│  (polls API) │                                  └───────────┘
└──────────────┘
```

- **Server** is the sole Waku client: publishes via LightPush, subscribes via Filter, queries Store
- **nwaku relay node** receives, stores (48h), and serves messages
- **Browser** does NOT connect to Waku directly — it polls `GET /api/events/waku-discovered` every 30s
- **Swarm directory** remains the authoritative source of truth; Waku only adds events not already in Swarm

### Why server-as-gateway?

Running a Waku light node in the browser requires ~500KB of JS and a direct WebSocket connection to nwaku. This adds load time and connectivity complexity. Instead, the server acts as a Waku gateway — one light node serves all clients. When Waku light clients mature (like Swarm light nodes), browsers can connect directly.

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

### Browser Discovery Client (`apps/web/src/lib/waku/discovery.svelte.ts`)

Svelte 5 rune-based reactive store that:

1. Polls `GET /api/events/waku-discovered` every 30 seconds
2. Merges discovered events with the Swarm directory (Swarm takes priority)
3. Provides `mergeWithWaku()`, `getWakuDiscoveredEvents()`, etc.

### Browser Waku Client (`apps/web/src/lib/waku/client.ts`)

Kept for future use — not currently imported by anything. When Waku light clients mature, browsers can connect directly to nwaku instead of polling the server API.

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
WAKU_BOOTSTRAP_PEERS=/ip4/127.0.0.1/tcp/8546/ws/p2p/<PEER_ID>
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

## Centralization & Future

The nwaku node is a centralization point (similar to the Swarm gateway). Mitigation paths:

1. **Multiple relay nodes**: Run 2-3 for redundancy; light clients can list multiple bootstrap peers
2. **Community nodes**: Other WoCo users can run their own nwaku nodes
3. **Browser direct connect**: The browser Waku client (`apps/web/src/lib/waku/client.ts`) is ready for when browsers can connect directly — just wire it in and remove the polling
4. **Public network improvement**: As the Waku network matures, dedicated relay nodes become optional

The architecture is designed so that if Waku is unavailable, the app works exactly as before using only the Swarm directory.
