# Waku Decentralized Event Discovery

WoCo uses the [Waku](https://waku.org/) protocol for decentralized event discovery alongside the Swarm directory. Waku provides real-time event announcements that supplement the authoritative Swarm feed-based directory.

## Architecture

```
┌──────────────┐     LightPush      ┌──────────────┐     Filter/Store    ┌──────────────┐
│  WoCo Server │ ──────────────────► │  nwaku Relay  │ ◄────────────────── │   Browser     │
│  (publisher) │                     │  (your node)  │                     │  (subscriber) │
└──────────────┘                     └──────────────┘                     └──────────────┘
                                           │
                                     Relay gossip
                                           │
                                     ┌─────▼─────┐
                                     │  Public    │
                                     │  Waku Net  │
                                     └───────────┘
```

- **Server** publishes event announcements via Waku LightPush when events are created or listed
- **nwaku relay node** receives, stores (48h), and serves messages to light clients
- **Browser** subscribes via Waku Filter (real-time) and queries Store (history)
- **Swarm directory** remains the authoritative source of truth; Waku only adds events not already in Swarm

## Components

### nwaku Relay Node (`nwaku/docker-compose.yml`)

Self-hosted [nwaku](https://github.com/waku-org/nwaku) relay node running on the Ubuntu server (192.168.0.144). Provides:

- **Relay**: propagates messages to the wider Waku network
- **Filter**: serves real-time subscriptions to browser light clients
- **LightPush**: accepts messages from the WoCo server
- **Store**: persists messages for 48 hours for historical queries

Configuration:
- Cluster ID: 42 (custom, avoids TWN RLN requirements)
- Single shard: 0
- Ports: 60000 (TCP), 8546 (WebSocket), 8645 (REST API)
- Image: `wakuorg/nwaku:v0.36.0`

### Server Waku Client (`apps/server/src/lib/waku/client.ts`)

Singleton light node that publishes event announcements. Lazy-initialized on first use.

- Gated by `WAKU_ENABLED=true` env var
- Connects to nwaku via `WAKU_BOOTSTRAP_PEERS` env var (multiaddr)
- Falls back to public Waku bootstrap if env var is not set
- Fire-and-forget: Waku failures never block HTTP responses

### Browser Waku Client (`apps/web/src/lib/waku/client.ts`)

Singleton light node for event discovery. Dynamically imported (~500KB) to keep initial page load fast.

- Connects to nwaku via `VITE_WAKU_BOOTSTRAP_PEERS` env var
- Falls back to public bootstrap if not configured
- Used by the discovery store (`apps/web/src/lib/waku/discovery.svelte.ts`)

### Waku Discovery Store (`apps/web/src/lib/waku/discovery.svelte.ts`)

Svelte 5 rune-based reactive store that:

1. Queries Waku Store for announcements from the last 48 hours
2. Subscribes to Waku Filter for real-time announcements
3. Merges discovered events with the Swarm directory (Swarm takes priority)
4. Handles "unlisted" announcements by removing events from the discovered set

### Shared Protocol (`packages/shared/src/waku/`)

- `constants.ts`: Content topic (`/woco/1/event-announce/proto`), cluster config
- `event-announce.ts`: Protobuf encoding/decoding for `EventAnnouncement` messages

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
# Enable Waku publishing
WAKU_ENABLED=true

# nwaku multiaddr (get peer ID from: curl http://192.168.0.144:8645/debug/v1/info)
WAKU_BOOTSTRAP_PEERS=/ip4/192.168.0.144/tcp/8546/ws/p2p/<PEER_ID>
```

### Frontend

```env
# nwaku multiaddr (same as server, but for browser WebSocket connection)
VITE_WAKU_BOOTSTRAP_PEERS=/ip4/192.168.0.144/tcp/8546/ws/p2p/<PEER_ID>
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

**Note**: The peer ID changes if the volume is removed (`docker volume rm nwaku_nwaku-data`). Update the bootstrap peer multiaddr in both server and frontend env vars if this happens.

## Centralization & Future

The nwaku node is a centralization point (similar to the Swarm gateway). Mitigation paths:

1. **Multiple relay nodes**: Run 2-3 for redundancy; light clients can list multiple bootstrap peers
2. **Community nodes**: Other WoCo users can run their own nwaku nodes
3. **Public network improvement**: As the Waku network matures, dedicated relay nodes become optional
4. **Browser light clients already work**: The `@waku/sdk` creates proper light clients; the relay node is infrastructure, not a dependency on WoCo

The architecture is designed so that if Waku is unavailable, the app works exactly as before using only the Swarm directory.
