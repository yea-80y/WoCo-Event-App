# WoCo — Decentralized Event Platform

**Live app:** [gateway.woco-net.com/bzz/...](https://gateway.woco-net.com/bzz/1b4f27ff3a6650fe2dbb4f6b40053ba2b1016dc72e174edb90c0dd46f03c2251/)

WoCo is a decentralized event ticketing platform built on the Swarm Network and Ethereum standards. Event organizers create events and issue signed tickets as PODs (Portable Object Data). Attendees claim tickets via wallet or email, and carry them in their on-chain passport.

For detailed technical documentation (cryptography, EIP-712 flows, encryption, Swarm architecture), see [docs/TECHNICAL_ARCHITECTURE.md](docs/TECHNICAL_ARCHITECTURE.md).

## Architecture

```
apps/web/              # Vite + Svelte 5 frontend
apps/server/           # Hono API server (Swarm relay + auth)
packages/shared/       # Shared TypeScript types and constants
packages/embed/        # <woco-tickets> Web Component for external sites
```

**Storage**: All data lives on Swarm Network feeds — no traditional database. Binary feed pages (4096 bytes, 128 slots x 32-byte refs) store ticket edition hashes. JSON feeds store event metadata, user collections, and claim records.

**Auth**: EIP-712 session delegation. The user's wallet signs a delegation granting a browser-generated session key permission to act on their behalf. This avoids repeated MetaMask popups.

**Identity layers**:
1. **Wallet** (secp256k1) — permanent Ethereum identity
2. **Session key** (secp256k1, random) — ephemeral, signs API requests
3. **POD identity** (ed25519, deterministic) — signs tickets, deferred to feature access

## Getting Started

### Prerequisites

- Node.js 20+
- npm 10+
- Access to a Swarm Bee node (configured in `apps/server/.env`)

### Install

```bash
npm install
```

### Development

```bash
# Start the API server (watches for changes)
npm run dev:server

# Start the web frontend (Vite dev server on :5173)
npm run dev:web
```

The web dev server proxies `/api` requests to the backend (configured via `PORT` env var).

### Build

```bash
npm run build:server   # TypeScript check
npm run build:web      # Production Vite build
npm run build:embed    # IIFE bundle → packages/embed/dist/woco-embed.js
```

### Environment

Create `apps/server/.env`:

```env
FEED_PRIVATE_KEY=<hex private key for platform feed signer>
POSTAGE_BATCH=<swarm postage batch ID>
BEE_URL=<your Bee node URL>
PORT=<server port>
# Optional: API key for organizer backend-to-backend claims
ORGANIZER_API_KEY=<secret>
```

## Features

### Event Creation

Organizers fill out event details (title, description, dates, location, image) and define ticket series with quantities. Tickets are signed with the creator's ed25519 key and uploaded to Swarm. The event directory feed is updated for discovery.

### Ticket Claiming (3 modes)

| Mode | Auth required | Identifier stored | Use case |
|------|--------------|-------------------|----------|
| **Wallet** | MetaMask connect | Wallet address | WoCo app + embed widget |
| **Email** | None | SHA-256 email hash | Embed widget (non-crypto users) |
| **API** | Organizer API key | Wallet or email | Backend-to-backend after payment |

Claiming is a single action — no EIP-712 signing or ed25519 derivation required at claim time. POD identity derivation is deferred to later feature access (forums, proof of attendance).

### Passport (My Tickets)

Authenticated users see their claimed tickets at `#/my-tickets`. The collection is stored as a JSON feed keyed by wallet address, read through authenticated API endpoints.

### Embed Widget

A standalone Web Component that organizers embed on their own websites. The embed code is generated via the **Embed Setup** page, accessible from any event detail page by clicking "Embed on your site".

The configurator lets organizers:
- Toggle event image and description visibility
- Choose claim method (wallet, email, or both)
- Select theme (dark or light)
- Copy the generated HTML snippet

```html
<script src="https://api.woco.eth/embed/woco-embed.js"></script>
<woco-tickets
  event-id="abc-123"
  api-url="https://api.woco.eth"
  claim-mode="both"
  theme="dark"
  show-image="true"
  show-description="false"
></woco-tickets>
```

**Attributes**:

| Attribute | Values | Default | Description |
|-----------|--------|---------|-------------|
| `event-id` | string | — | Event identifier (required) |
| `api-url` | URL | — | WoCo API base URL (required) |
| `claim-mode` | `wallet` / `email` / `both` | `wallet` | How users claim tickets |
| `theme` | `dark` / `light` | `dark` | Widget colour scheme |
| `show-image` | `true` / `false` | `true` | Show event image in header |
| `show-description` | `true` / `false` | `false` | Show event description |

**Events**: Dispatches `woco-claim` CustomEvent on successful claims with `{ seriesId, mode, address|email, edition }` in detail.

**Bundle**: ~10KB / 3KB gzipped. No framework dependencies — vanilla TypeScript with Shadow DOM.

## Routes

| Hash route | Page |
|-----------|------|
| `#/` | Event listing |
| `#/create` | Create event form |
| `#/event/:id` | Event detail + claim buttons |
| `#/event/:id/embed` | Embed configurator |
| `#/my-tickets` | Passport (claimed tickets) |
| `#/dashboard` | Organizer event list |
| `#/dashboard/:id` | Orders dashboard (decrypt + webhook) |

## Swarm Feed Layout

```
woco/event/directory                     # Global event listing (JSON)
woco/event/{eventId}                     # Event details + series (JSON)
woco/pod/editions/{seriesId}             # Page 0: slot 0=metadata, 1-127=tickets
woco/pod/editions/{seriesId}/p{N}        # Pages 1+: 128 tickets each
woco/pod/claims/{seriesId}[/p{N}]        # Mirrors editions layout
woco/pod/claimers/{seriesId}             # Who claimed what (JSON)
woco/pod/collection/{ethAddress}         # User's ticket collection (JSON)
woco/pod/creator/{creatorPodKey}         # Creator's event index (JSON)
```

Binary pages use 128 slots x 32 bytes = 4096 bytes. JSON feeds are padded to 4096 bytes with null bytes. Multi-page support allows unlimited tickets per series (127 on page 0, 128 per additional page).

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | No | Health check |
| POST | `/api/auth/whoami` | Session | Verify session delegation |
| GET | `/api/events` | No | List all events |
| GET | `/api/events/:id` | No | Get event details |
| POST | `/api/events` | Session | Create event (streaming NDJSON) |
| POST | `/api/events/:eid/series/:sid/claim` | No | Claim a ticket |
| GET | `/api/events/:eid/series/:sid/claim-status` | No | Check availability |
| GET | `/api/collection/me` | Session | Get user's ticket collection |
| GET | `/api/collection/me/ticket/:ref` | Session | Get claimed ticket detail |
| GET | `/api/events/:id/orders` | Session (organizer) | Get all orders for event |
| POST | `/api/events/:id/webhook-relay` | Session (organizer) | Forward decrypted data to webhook |

## Project Status

- [x] Monorepo scaffolding with npm workspaces
- [x] Auth: web3 wallet + local browser account with EIP-712 session delegation
- [x] Deferred signing ("build first, sign later" UX)
- [x] Event creation with Swarm feeds
- [x] Multi-page ticket editions (no quantity limit)
- [x] Ticket claiming (wallet + email modes, no auth required)
- [x] End-to-end encrypted order data (ECIES: X25519 + AES-256-GCM)
- [x] Organizer dashboard with local decryption, CSV export, webhook relay
- [x] Passport / My Tickets page
- [x] Embed widget with setup configurator
- [x] Production deployment (Swarm feed + Cloudflare tunnel)
- [ ] User profile page
- [ ] Zupass login integration
- [ ] Para wallet integration
- [ ] Smart contract claims (replace platform signer)

## Tech Stack

- **Frontend**: Vite + Svelte 5 + TypeScript
- **Backend**: Hono + TypeScript
- **Storage**: Swarm Network (bee-js)
- **Auth**: EIP-712 (ethers.js), ed25519 (@noble/ed25519)
- **Embed**: Vanilla TypeScript Web Component (IIFE bundle)
