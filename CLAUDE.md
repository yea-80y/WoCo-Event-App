WoCo App - Decentralized event platform built on Swarm Network and Ethereum standards

  STACK:
  - Frontend: Vite + Svelte 5 + TypeScript (apps/web)
  - Backend: Hono + TypeScript (apps/server)
  - Storage: Swarm Network feeds (no database)
  - Auth: EIP-712 session delegation (wallet delegates to session key)
  - Monorepo: npm workspaces
  - Embed: Vanilla TypeScript Web Component (packages/embed)

  STRUCTURE:
  apps/web/              # Vite + Svelte main platform UI
  apps/server/           # Hono API server (Swarm relay + auth)
  packages/shared/       # Shared types, POD schema, constants
  packages/embed/        # <woco-tickets> Web Component (IIFE bundle, ~35KB)
  packages/site-builder/ # Static site generator for user events [planned]

  DEPLOYMENT:
  - Backend server: 192.168.0.144 (user: ntl-dev), dir: ~/woco-events-server
  - Frontend: Swarm feed via gateway.woco-net.com
  - API: events-api.woco-net.com (Cloudflare tunnel to :3001)
  - Live URL: https://gateway.woco-net.com/bzz/<hash>/
  - Planned: woco.eth content hash update (ENS currently in grace period)
  - Old app at woco.eth.limo — will link from new app
  - GitHub: github.com/yea-80y/woco_app

  PRODUCTION ENV (apps/server/.env on server laptop):
  - ALLOWED_HOSTS must include all frontend hosts (gateway.woco-net.com, etc.)
  - CRITICAL: Never overwrite server .env during deploy (exclude from rsync)
  - Local .env and server .env differ — server has production ALLOWED_HOSTS

  BUILD STATUS (as of 2026-02-18):
  [x] Monorepo scaffolding with npm workspaces
  [x] Auth overhaul: web3 wallet + local browser account (2 of 3 methods)
  [x] "Build first, sign later" UX (deferred signing at publish/claim time)
  [x] Forget identity (sign out clears session, local key persists for re-login)
  [x] IndexedDB encrypted storage (AES-256-GCM)
  [x] Event creation: form, image upload, ticket signing, Swarm feeds
  [x] Event listing + detail views with hash-based routing
  [x] Multi-page edition feeds (no ticket quantity limit)
  [x] Ticket claiming: wallet (authenticated) + email (rate-limited)
  [x] Always-on encryption for claim data (ECIES: X25519 + AES-256-GCM)
  [x] Organizer dashboard: encrypted order decryption, CSV export
  [x] Webhook relay: manual send to email services
  [x] My Tickets / Passport page (with lazy session delegation)
  [x] Embed widget: email claims working, setup configurator
  [x] Server serves embed JS at /embed/woco-embed.js
  [x] Home page: hero, how-it-works, features, coming soon, footer
  [x] Bottom navigation bar (mobile/PWA-ready)
  [x] Production deployment (Swarm feed + Cloudflare tunnel)
  [x] Technical architecture documentation (docs/TECHNICAL_ARCHITECTURE.md)
  [ ] Embed widget: wallet claims (needs session delegation in widget)
  [ ] Zupass login integration (3rd auth method)
  [ ] Para wallet integration (replaces local account)
  [ ] ENS content hash update (woco.eth)
  [ ] User profile page
  [ ] PWA manifest + service worker

  ============================================================================
  CLAIMING SECURITY MODEL
  ============================================================================

  WALLET CLAIMS (main app):
  - Require session delegation (EIP-712) — proves address ownership
  - Server verifies delegation, uses verified parentAddress (not request body)
  - Prevents impersonation (can't claim as someone else's address)
  - Flow: login → ensureSession() → authPost to claim endpoint

  EMAIL CLAIMS (embed widget + main app):
  - Unauthenticated but rate-limited: 3 claims per 15 minutes per IP
  - IP extracted from x-forwarded-for or cf-connecting-ip headers
  - Email stored as SHA-256 hash in claimers feed
  - Actual email encrypted in order data (only organizer can read)

  EMBED WIDGET CLAIMS:
  - Currently email-only (wallet disabled in configurator as "Coming soon")
  - Wallet claims in embed need full session delegation flow — significant work
  - Widget dispatches woco-claim CustomEvent on success

  ============================================================================
  AUTH PATTERN (Deferred Signing)
  ============================================================================

  Key principle: login connects/creates account, EIP-712 signing is deferred
  to the first action that needs it (publish, claim, view tickets).

  LOGIN (no EIP-712):
  - Web3: connectWallet() → stores address, kind="web3"
  - Local: createLocalAccount() → generates secp256k1 keypair, stores in IDB

  DEFERRED SIGNING (lazy, on demand):
  - ensureSession(): triggered by publish, claim, or viewing My Tickets
  - For web3: MetaMask popup for EIP-712 AuthorizeSession
  - For local: SigningConfirmDialog shows what's being signed, user clicks Sign
  - ensurePodIdentity(): triggered by publish (needed to sign tickets)

  GLOBAL LOGIN REQUEST PATTERN:
  - loginRequest.request() → returns Promise<boolean>
  - Opens LoginModal globally from any component
  - Used by: ClaimButton, PublishButton, MyTickets, nav sign-in button
  - Pattern copied from signingRequest (Promise-based rune store)

  PAGES THAT TRIGGER AUTH:
  - ClaimButton: loginRequest → ensureSession → claim API call
  - PublishButton: loginRequest → ensureSession → ensurePodIdentity → publish
  - MyTickets: loginRequest → ensureSession → load collection
  - All use the same pattern: check connected, check session, then proceed

  ============================================================================
  AUTH METHODS
  ============================================================================

  OPTION 1: Web3 Wallet (MetaMask, etc.) — WORKING
  - Parent key = wallet's secp256k1 account
  - EIP-712 signed by wallet (MetaMask popup)

  OPTION 2: Local Browser Account — WORKING
  - Random secp256k1 keypair stored in IndexedDB (AES-GCM encrypted)
  - EIP-712 signed locally via ethers.Wallet.signTypedData()
  - SigningConfirmDialog shows details before user approves
  - Backup button exports private key
  - Persists across sessions; sign-out clears session but keeps key

  OPTION 3: Zupass Login — NOT YET IMPLEMENTED
  - Zupass provides ed25519 directly (no EIP-712 derivation)
  - Needs adapter for session delegation

  THREE IDENTITY LAYERS:
  1. Primary wallet (secp256k1) — permanent identity
  2. Session key (secp256k1, random) — ephemeral, signs API requests
  3. POD identity (ed25519, deterministic) — signs tickets
  - Session delegation: random nonce (per-session)
  - POD identity: fixed nonce "WOCO-POD-IDENTITY-V1" (deterministic)

  ============================================================================
  SWARM CONFIG
  ============================================================================

  - Frontend Bee gateway: https://gateway.woco-net.com
  - Backend Bee (local): http://192.168.0.144:3323
  - Postage batch: env POSTAGE_BATCH_ID (server-only)
  - Feed private key: env FEED_PRIVATE_KEY (server-only, never expose)
  - Vite base: './' (relative paths — required for Swarm bzz paths)
  - Upload script: scripts/upload-to-swarm-feed.cjs (CommonJS, not .js)

  SWARM PATTERNS:
  - All feed data uses 4096-byte binary pages (128 slots x 32 bytes)
  - JSON feeds pad to 4096 bytes with null bytes
  - Topic naming: woco/{domain}/{entity}/{id}
  - Platform signer owns all feeds (single private key) — centralized for now
  - Retry with exponential backoff for feed propagation delays

  FEED TOPICS:
  woco/event/directory                    # Global event listing (JSON feed)
  woco/event/{eventId}                    # Event details + ticket series (JSON feed)
  woco/pod/editions/{seriesId}            # Page 0: slot 0=metadata, slots 1-127=tickets
  woco/pod/editions/{seriesId}/p{N}       # Pages 1+: 128 tickets per page
  woco/pod/claims/{seriesId}[/p{N}]       # Mirrors editions layout
  woco/pod/claimers/{seriesId}            # Who claimed what (JSON feed)
  woco/pod/collection/{ethAddress}        # User's ticket collection (JSON feed)
  woco/pod/creator/{creatorPodKey}        # Creator's event index (JSON feed)

  ============================================================================
  EMBED WIDGET
  ============================================================================

  - packages/embed — vanilla TypeScript Web Component (<woco-tickets>)
  - Build: npm run build:embed → packages/embed/dist/woco-embed.js (IIFE)
  - Served by API server at /embed/woco-embed.js (apps/server/src/index.ts)
  - Setup page: #/event/:id/embed (EmbedSetup.svelte)
  - v1: email claims only (wallet needs session delegation — coming soon)
  - Handles order form encryption (sealJson with event's encryptionKey)
  - Shadow DOM for style isolation

  ============================================================================
  TICKET SYSTEM
  ============================================================================

  - Series = event ticket type (has totalSupply, metadata, image)
  - Editions = individual tickets (signed by creator's ed25519 key)
  - Ticket format: woco.ticket.v1 / woco.ticket.claimed.v1
  - Claiming: backend finds next unclaimed slot, creates claimed version
  - Always-on encryption: every claim encrypts data for organizer dashboard
    (even without order form fields — encrypts seriesId + claimerAddress/Email)

  ============================================================================
  UI/UX
  ============================================================================

  - Dark theme with CSS custom properties (app.css)
  - Accent: warm violet (#7c6cf0)
  - Bottom nav bar: Home, Create, Tickets (auth), Dashboard (auth)
  - Top bar: logo + session status only (compact icon buttons for mobile)
  - Hash-based routing: #/ #/create #/event/:id #/my-tickets #/dashboard etc.
  - SessionStatus: kind badge + truncated address + icon buttons (lock, X)
  - Mobile-first: flex layout, no wrapping nav items

  ============================================================================
  KEY FILES
  ============================================================================

  AUTH:
  apps/web/src/lib/auth/auth-store.svelte.ts     # Main auth state machine
  apps/web/src/lib/auth/login-request.svelte.ts   # Global login popup trigger
  apps/web/src/lib/auth/signing-request.svelte.ts # EIP-712 confirm dialog trigger
  apps/web/src/lib/auth/session-delegation.ts     # Session key + delegation
  apps/web/src/lib/auth/pod-identity.ts           # POD key derivation
  apps/web/src/lib/auth/local-account.ts          # Local browser account
  apps/web/src/lib/auth/signers/index.ts          # Web3 + local EIP-712 signers
  apps/web/src/lib/api/client.ts                  # authPost/authGet (attaches delegation)

  COMPONENTS:
  apps/web/src/App.svelte                         # Shell: top bar + routing + bottom nav
  apps/web/src/lib/components/auth/LoginModal.svelte        # Login method picker
  apps/web/src/lib/components/auth/SigningConfirmDialog.svelte # EIP-712 confirm
  apps/web/src/lib/components/events/ClaimButton.svelte     # Claim flow orchestrator
  apps/web/src/lib/components/events/PublishButton.svelte   # Publish flow orchestrator
  apps/web/src/lib/components/passport/MyTickets.svelte     # Ticket collection
  apps/web/src/lib/components/dashboard/Dashboard.svelte    # Organizer order view
  apps/web/src/lib/components/embed/EmbedSetup.svelte       # Embed configurator

  SERVER:
  apps/server/src/index.ts                        # Routes + embed JS serving
  apps/server/src/middleware/auth.ts               # Session delegation verification
  apps/server/src/routes/claims.ts                 # Claim endpoint (wallet auth + email rate limit)
  apps/server/src/routes/collection.ts             # User ticket collection
  apps/server/src/lib/auth/verify-delegation.ts    # EIP-712 verification + host check

  ============================================================================
  CONVENTIONS
  ============================================================================

  - TypeScript strict mode everywhere
  - Shared types in packages/shared (single source of truth)
  - Environment variables: VITE_ prefix for frontend, plain for server
  - API responses: { ok: boolean, data?: T, error?: string }
  - Lowercase eth addresses for deterministic feed topics
  - Hex strings: no 0x prefix for Swarm refs (Hex64), 0x prefix for eth (Hex0x)
  - CSS: use var(--token) from app.css, never hardcoded hex
  - Server .env at apps/server/.env (gitignored)
  - Svelte 5 runes ($state, $derived, $effect) — no stores API

  HONO SERVER TYPING:
  - AppEnv type in src/types.ts defines context variables
  - SESSION_TYPES needs cast: SESSION_TYPES as unknown as Record<string, TypedDataField[]>

  DEV COMMANDS:
  npm run dev:web        # Vite dev server on :5173
  npm run dev:server     # tsx watch on :3001
  npm run build:web      # Production Vite build
  npm run build:server   # TypeScript check
  npm run build:embed    # IIFE bundle → packages/embed/dist/woco-embed.js

  KNOWN GOTCHAS:
  - Vite base must be './' (relative) — absolute paths break under Swarm /bzz/ URLs
  - Upload script is .cjs (not .js) — monorepo has "type": "module"
  - ALLOWED_HOSTS on server must include all frontend hosts or session delegation fails with 403
  - Server .env differs from local .env — NEVER overwrite during rsync
  - Local account sign-out clears session but keeps keypair for re-login
  - MyTickets triggers ensureSession on mount (lazy EIP-712) — not just login
  - Embed wallet claims disabled (need session delegation support in widget)
