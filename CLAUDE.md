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
  packages/embed/        # <woco-tickets> Web Component (IIFE bundle, ~71KB)
  packages/site-builder/ # Static site generator for organiser events [next stage]

  DEPLOYMENT:
  - Backend server: 192.168.0.144 (user: ntl-dev), dir: ~/woco-events-server
  - Frontend: Swarm feed via gateway.woco-net.com AND woco.eth.limo (ENS updated)
  - API: events-api.woco-net.com (Cloudflare tunnel to :3001)
  - Live URLs: https://woco.eth.limo/ and https://gateway.woco-net.com/bzz/<hash>/
  - ENS: woco.eth content hash updated — woco.eth.limo now serves the current app
  - GitHub: github.com/yea-80y/WoCo-Event-App

  PRODUCTION ENV (apps/server/.env):
  - apps/server/.env on THIS LAPTOP is the master copy — always edit here first
  - .env IS synced to server on every deploy (laptop overwrites server)
  - ALLOWED_HOSTS must include all frontend hosts (gateway.woco-net.com, etc.)
  - BEE_URL=http://192.168.0.144:3323 (single Bee node, same address for both laptop and server)

  ============================================================================
  BUILD STATUS (as of 2026-02-26)
  ============================================================================

  CORE PLATFORM — COMPLETE:
  [x] Monorepo scaffolding with npm workspaces
  [x] Auth overhaul: web3 wallet + local browser account + Para embedded wallet
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
  [x] Embed widget: email + wallet + passkey claims working, setup configurator
  [x] Server serves embed JS at /embed/woco-embed.js (~71KB, versioned with ?v=N)
  [x] Home page: hero, how-it-works, features, coming soon, footer
  [x] Bottom navigation bar (mobile/PWA-ready)
  [x] Production deployment (Swarm feed + Cloudflare tunnel + woco.eth.limo via ENS)
  [x] Technical architecture documentation (docs/TECHNICAL_ARCHITECTURE.md)
  [x] Embed widget: wallet + passkey claims (EIP-191 signed, no session delegation needed)
  [x] Embed widget: iframe approach for cross-domain passkey identity (ENS subdomains)
  [x] Double-spend prevention for ticket claims (server-side slot locking)
  [x] Organizer approval flow: approvalRequired per series, pending-claims feed,
      approve/reject endpoints, ClaimButton shows "Request to attend" / "Pending Approval",
      embed widget shows pending state, Dashboard approvals tab
  [x] Client-side stale-while-revalidate caching
  [x] Para embedded wallet (auth method 3): email → Para hosted iframe → EVM wallet
      - packages: @getpara/web-sdk + @getpara/ethers-v6-integration
      - API key: beta_418f67cf61e322ee04de9c1d8ccfdffa (BETA env)
      - Para signs EIP-712 for session delegation AND POD identity derivation
      - Dashboard decryption works (POD seed stored after first Para sign)
      - ParaLogin.svelte: email input → iframe step → waiting step

  NEXT STAGE — DEVCON/EF PITCH:
  [x] Self-hosted backend packaging — Dockerfile, docker-compose.yml, .env.example,
      docs/self-hosted-setup.md. Organiser clones repo, fills .env, docker compose up.
      Zero WoCo dependency after setup. Bee port 1633 (standard).
  [x] Site builder MVP — COMPLETE
      - SiteApp.svelte: minimal shell (#/ EventPage + #/dashboard Dashboard)
      - vite.site.config.ts: separate build → apps/web/dist-site/
      - SiteBuilder.svelte: form at #/site-builder (event picker + API URL + gateway)
      - Output: downloadable apps/web/.env.site + copy-paste build/upload instructions
      - Auth: web3 wallet + Para (SiteLoginModal — no local account)
      - Claim flow: ClaimButton.svelte reused as-is
      - Dashboard: Dashboard.svelte reused directly
      - Upload: scripts/upload-site-to-swarm.cjs (npm run upload:site)
      - Entry: site.html → site-main.ts → SiteApp.svelte
      - DashboardIndex: "Build a standalone event site" CTA → #/site-builder
  [x] Mock payment page + dual-feed identity association (2026-02-26)
      - SeriesSummary.paymentRedirectUrl? — claim button becomes "Register & Pay"
      - GET /api/events/:eventId/series/:seriesId/mock-payment-page — self-contained HTML
        Query: email, walletAddress, returnUrl, amount, currency
        Shows identity choice: link to wallet / link to email / use different wallet
      - POST /api/events/:eventId/series/:seriesId/mock-payment — mints + dual feeds
        Body: { email?, walletAddress?, linkWallet?, linkEmail?, altWallet? }
      - addToEmailCollection(emailHash, entry) → woco/pod/collection/email:{hash}
      - EventPage.svelte: handles ?claimed=1&edition=N return from payment page
      - SiteBuilder step 3: paymentRedirectUrl field per tier
      - paymentRedirectUrl flows: shared types → events route → service.ts → SeriesSummary
  [x] Discover + list/unlist events from external server (2026-02-26, updated 2026-02-27)
      - POST /api/events/discover — fetches GET {sourceApiUrl}/api/events, filters by
        caller's address, cross-references WoCo directory, returns {listed: bool} per event
        Does NOT auto-list. No event ID required — discovered by wallet address alone.
      - POST /api/events/:id/list — explicit: fetches event, verifies creator, adds to dir
      - POST /api/events/:id/unlist — removes from WoCo PUBLIC directory ONLY
        Organiser's "My Events" view is NOT affected (uses creator index feed)
      - removeEventFromDirectory(eventId) in service.ts — public directory only
      - GET /api/events/mine (authenticated) — returns organiser's events from creator index
        Falls back to filtered global directory for events predating the index.
        "My Events" section uses this endpoint — unlist does not remove events here.
      - Per-creator index feed: woco/event/creator/{ethAddress} (never removed from)
        Written in addToEventDirectory() — called on both create and list operations
        topicCreatorDirectory(ethAddress) in topics.ts
      - DashboardIndex: uses authGet("/api/events/mine") for top "My Events" section
      - DashboardIndex: discover form (API URL only) + per-event List/Unlist toggle
        Discovered events are clickable → navigate to event dashboard
      - Auto-listing on WoCo-created events unchanged (still added on creation)
  [ ] Content hash registry (woco/registry/verified-frontends feed + WoCo signature)
  [ ] Payment webhook endpoint (receive confirmation → mint ticket; mock-friendly)
  [ ] Zupass login (4th auth method — ed25519 adapter for session delegation)
  [ ] User profile page
  [ ] PWA manifest + service worker

  ============================================================================
  NEXT STAGE ARCHITECTURE: DEVCON / EF PITCH
  ============================================================================

  GOAL: Build toward a pitch to the Ethereum Foundation to use WoCo infrastructure
  for Devcon ticket sales. Starting target: side events and affiliated orgs (usable
  nearly now). Longer term: Devcon main event.

  SCALE CONTEXT:
  - Devcon sells ~15,000 tickets in phased rounds over weeks — not a throughput
    problem, a reliability problem. A well-hosted Bee node + robust server handles
    this comfortably. Swarm reads are distributed and gateway-cached.
  - Side events are the strongest near-term use case.

  1. ORGANISER-HOSTED BACKEND:
  - EF (or any organiser) clones/downloads WoCo's apps/server package
  - They deploy on their own hardware with their own:
    * Bee node (or hosted Bee service)
    * FEED_PRIVATE_KEY (they own all feeds — WoCo has no access)
    * POSTAGE_BATCH_ID
    * ALLOWED_HOSTS (their frontend domains)
  - Zero reliance on WoCo servers after setup
  - WoCo provides the code; organiser owns and operates everything
  - Organiser returns an API URL; WoCo frontend connects to it
  - Packaging work: Docker Compose + setup guide + env template

  2. STATIC FRONTEND SITE BUILDER (packages/site-builder):
  - WoCo app feature: form-based builder for organiser's event frontend
  - Inputs: event name, dates, location, ticket series, payment redirect URL,
    gateway URL (recommend gateway.ethswarm.org for production), claim modes
    (wallet / email / Para), organiser's API server URL
  - Output: self-contained static site (Vite build), uploaded to Swarm
  - Returns content hash → organiser sets on their ENS (event.devcon.eth)
    or optionally a WoCo sub-ENS (devcon8.woco.eth)
  - IMPORTANT: generated frontend includes Dashboard.svelte for attendee mgmt
    (reuse existing component — it's already pure client-side, just needs the
    correct API URL configured to point at the organiser's own server)

  3. DEVCON TEAM ATTENDEE DASHBOARD:
  - The generated site builder frontend will include a /dashboard route
  - Reuse Dashboard.svelte + approvals tab entirely — zero new dashboard code
  - Organiser logs in with Para (no MetaMask needed for EF team members)
  - Dashboard decrypts order data locally using their POD seed
  - approve/reject pending claims, CSV export — all existing functionality
  - The only config needed: dashboard API URL points to organiser's own server

  4. CONTENT HASH REGISTRY:
  - Every verified event frontend uploaded to Swarm via site builder gets a
    signed entry in a WoCo-maintained registry feed:
    woco/registry/verified-frontends
  - Entry: { hash, eventId, organiserAddress, verifiedAt, wocoSignature }
  - Certificate-transparency-style: anyone can verify a frontend is genuine
    before interacting with it — prevents phishing clones of Devcon ticket page
  - Build into the site builder publish step from day one
  - Long-term candidate: on-chain registry (ENS text record, simple contract)

  5. PAYMENT WEBHOOK:
  - Devcon has their own payment infrastructure
  - Architecture: user completes form → redirect to organiser's payment URL →
    payment processor sends webhook to WoCo backend → ticket minted on Swarm
  - Server-side endpoint receives payment confirmation → triggers claim/mint
  - Mock-friendly: can be triggered manually for testing without real payment
  - Real integration requires collaboration with EF's payment team

  6. SWARM GATEWAY FOR PRODUCTION SITES:
  - Site builder should let organisers configure which gateway to use
  - Recommend gateway.ethswarm.org (robust public gateway) for production
  - gateway.woco-net.com runs on a home laptop — not suitable for Devcon scale

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
  - Para: email → Para iframe → wallet created → address stored, kind="para"

  DEFERRED SIGNING (lazy, on demand):
  - ensureSession(): triggered by publish, claim, or viewing My Tickets
  - For web3: MetaMask popup for EIP-712 AuthorizeSession
  - For local: SigningConfirmDialog shows what's being signed, user clicks Sign
  - For Para: Para's own hosted signing UI (popup/iframe from Para SDK)
  - ensurePodIdentity(): triggered by publish AND dashboard decrypt (first time)
  - For Para: second Para signing prompt — derives deterministic ed25519 POD key
    (subsequent dashboard opens use stored POD seed, no Para re-sign needed)

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

  OPTION 1: Web3 Wallet (MetaMask, WalletConnect) — WORKING
  - Parent key = wallet's secp256k1 account
  - EIP-712 signed by wallet (MetaMask popup or WalletConnect)

  OPTION 2: Local Browser Account — WORKING
  - Random secp256k1 keypair stored in IndexedDB (AES-GCM encrypted)
  - EIP-712 signed locally via ethers.Wallet.signTypedData()
  - SigningConfirmDialog shows details before user approves
  - Backup button exports private key
  - Persists across sessions; sign-out clears session but keeps key

  OPTION 3: Para Embedded Wallet — WORKING
  - No browser extension needed — users onboard via email
  - Flow: email input → Para hosted iframe (OTP / passkey) → EVM wallet created
  - Para manages the wallet key on their infrastructure (MPC)
  - EIP-712 signed via ParaEthersSigner.signTypedData() → Para shows their UI
  - Session restore: para.isSessionActive() checked on init
  - Logout: para.logout() called on sign-out
  - API key: beta_418f67cf61e322ee04de9c1d8ccfdffa (BETA environment)
  - Files: apps/web/src/lib/auth/para-client.ts
           apps/web/src/lib/auth/para-account.ts
           apps/web/src/lib/auth/signers/para-signer.ts
           apps/web/src/lib/components/auth/ParaLogin.svelte
  - VITE_PARA_API_KEY in apps/web/.env and .env.production

  OPTION 4: Zupass Login — NOT YET IMPLEMENTED
  - Zupass provides ed25519 directly (no EIP-712 derivation)
  - Needs adapter for session delegation

  THREE IDENTITY LAYERS:
  1. Primary wallet (secp256k1) — permanent identity
  2. Session key (secp256k1, random) — ephemeral, signs API requests
  3. POD identity (ed25519, deterministic) — signs tickets + derives encryption key
  - Session delegation: random nonce (per-session)
  - POD identity: fixed nonce "WOCO-POD-IDENTITY-V1" (deterministic)
  - Dashboard decryption key: derived from POD seed via deriveEncryptionKeypairFromPodSeed()

  ============================================================================
  SWARM CONFIG
  ============================================================================

  - Frontend Bee gateway: https://gateway.woco-net.com
  - Backend Bee (local): http://192.168.0.144:3323
  - Postage batch: env POSTAGE_BATCH_ID (server-only)
  - Feed private key: env FEED_PRIVATE_KEY (server-only, never expose)
  - Vite base: './' (relative paths — required for Swarm bzz paths)
  - Upload script: scripts/upload-to-swarm-feed.cjs (CommonJS, not .js)
  - Production gateway for generated sites: use gateway.ethswarm.org (not woco-net)

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
  woco/pod/creator/{creatorPodKey}        # Creator's event index (JSON feed) [not yet used]
  woco/event/creator/{ethAddress}         # Per-organiser event index (never deleted from)
                                          # topicCreatorDirectory(). Used by GET /api/events/mine
  woco/pod/pending-claims/{seriesId}      # Approval queue (JSON feed, organizer-only)
  woco/registry/verified-frontends        # [planned] Content hash registry (signed)

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
  apps/web/src/lib/auth/para-client.ts            # Para SDK singleton (BETA)
  apps/web/src/lib/auth/para-account.ts           # Para auth flow + session restore
  apps/web/src/lib/auth/signers/index.ts          # Web3 + local + Para EIP-712 signers
  apps/web/src/lib/auth/signers/para-signer.ts    # ParaEthersSigner wrapper
  apps/web/src/lib/api/client.ts                  # authPost/authGet (attaches delegation)

  COMPONENTS:
  apps/web/src/App.svelte                         # Shell: top bar + routing + bottom nav
  apps/web/src/lib/components/auth/LoginModal.svelte        # Login method picker
  apps/web/src/lib/components/auth/SigningConfirmDialog.svelte # EIP-712 confirm (local/passkey)
  apps/web/src/lib/components/auth/ParaLogin.svelte         # Para email → iframe flow
  apps/web/src/lib/components/events/ClaimButton.svelte     # Claim flow orchestrator
  apps/web/src/lib/components/events/PublishButton.svelte   # Publish flow orchestrator
  apps/web/src/lib/components/passport/MyTickets.svelte     # Ticket collection
  apps/web/src/lib/components/dashboard/Dashboard.svelte    # Organizer order view + approvals
  apps/web/src/lib/components/embed/EmbedSetup.svelte       # Embed configurator

  SERVER:
  apps/server/src/index.ts                        # Routes + embed JS serving
  apps/server/src/middleware/auth.ts               # Session delegation verification
  apps/server/src/routes/claims.ts                 # Claim endpoint (wallet auth + email rate limit)
  apps/server/src/routes/approvals.ts              # Approve/reject pending claims (organizer auth)
  apps/server/src/routes/collection.ts             # User ticket collection
  apps/server/src/lib/event/claim-service.ts       # Core claim + approval logic
  apps/server/src/lib/event/service.ts             # Event creation
  apps/server/src/lib/swarm/topics.ts              # Feed topic derivation
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

  APPROVAL FLOW:
  - Series can have approvalRequired: true (set at creation, stored in series metadata)
  - Claim returns { approvalPending: true, pendingId } instead of instant ticket
  - Slot reserved immediately on request (prevents double-assign on concurrent approvals)
  - Pending entry written to woco/pod/pending-claims/{seriesId} feed
  - GET /api/events/:id/pending-claims — organizer views queue (header auth)
  - POST .../pending-claims/:pendingId/approve — finalises ticket, updates claimers feed
  - POST .../pending-claims/:pendingId/reject — zeroes out reserved slot, frees it
  - ClaimButton shows "Request to attend" / amber "Pending Approval" badge
  - Embed widget shows "Pending Approval" state after submit
  - Dashboard has "Approvals (N)" tab alongside Orders
  - GET /claim-status returns userPendingId when pending, userEdition when approved
  - Header auth for GET routes: x-session-address + x-session-delegation (base64 JSON)

  KNOWN BUGS (as of 2026-02-27 — to be fixed):
  - mock-payment CollectionEntry.claimedRef uses ticket.originalPodHash (original ticket)
    instead of the actual claimed ticket Swarm ref — claimTicket() doesn't return claimedRef.
    Fix: add claimedRef to ClaimResult type and return it from claimTicket().
  - Mock payment series.price is always 0 (hardcoded in service.ts) so payment page always
    shows "Free (demo)" — price field needs wiring through the create event flow.
  - Hono default 404 returns plain text "404 Not Found" — authPost's resp.json() throws
    "Unexpected non-whitespace character after JSON at position 4". Consider adding a
    global 404 JSON handler in index.ts.

  KNOWN GOTCHAS:
  - Vite base must be './' (relative) — absolute paths break under Swarm /bzz/ URLs
  - Upload script is .cjs (not .js) — monorepo has "type": "module"
  - ALLOWED_HOSTS on server must include all frontend hosts or session delegation fails with 403
  - Server .env differs from local .env — NEVER overwrite during rsync
  - Local account sign-out clears session but keeps keypair for re-login
  - MyTickets triggers ensureSession on mount (lazy EIP-712) — not just login
  - Embed wallet claims disabled (need session delegation support in widget)
  - Svelte 5 $state proxy: properties absent from initial object literal aren't reactive;
    always initialise all fields at declaration time (e.g. approvalRequired: false, not omitted)
  - bee-js v11: writer.upload() requires new Reference(hexString), not a plain string;
    feed verification uses feed.feedIndex (not feed.reference which no longer exists)
  - Para SDK adds ~640KB to the bundle (expected); "use client" warnings from Para
    are benign — Rollup/Vite ignores them
  - Para wallet address is optional on the Wallet type — always check for presence
    and retry with backoff after waitForLogin/waitForWalletCreation resolves
  - Para wallets filtered by type "EVM" when retrieving address (para.wallets is a
    Record<string, Wallet> — iterate with Object.values())
