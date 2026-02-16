 WoCo App - Decentralized event platform built on Swarm Network and Ethereum standards

  STACK:
  - Frontend: Vite + Svelte 5 + TypeScript (apps/web)
  - Backend: Hono + TypeScript (apps/server)
  - Storage: Swarm Network feeds (no database)
  - Auth: EIP-712 session delegation (wallet delegates to session key)
  - Monorepo: npm workspaces

  STRUCTURE:
  apps/web/              # Vite + Svelte main platform UI
  apps/server/           # Hono API server (Swarm relay + auth)
  packages/shared/       # Shared types, POD schema, constants
  packages/embed/        # Embeddable ticket widget (Web Components) [planned]
  packages/site-builder/ # Static site generator for user events [planned]

  DEPLOYMENT:
  - Backend server: 192.168.0.144 (user: ntl-dev)
  - Frontend: Static export deployed to Swarm via feed update
  - Planned: events.woco.eth (sub-ENS) for event app
  - GitHub: github.com/yea-80y/woco_app

  BUILD STATUS (as of 2026-02-16):
  [x] Monorepo scaffolding with npm workspaces
  [x] Wallet auth: session delegation + POD identity derivation
  [x] IndexedDB encrypted storage (AES-256-GCM)
  [x] Event creation: form, image upload, ticket signing, Swarm feeds
  [x] Event listing + detail views with hash-based routing
  [x] Multi-page edition feeds (no ticket quantity limit)
  [x] Ticket claiming flow (backend + frontend)
  [x] UI/UX polish: CSS custom properties, cohesive dark theme
  [x] All TypeScript errors resolved (server + web builds clean)
  [x] Organizer dashboard: encrypted order decryption, CSV export
  [x] Webhook relay: manual send to email services (SendGrid, Zapier, etc.)
  [ ] Auth overhaul: three login methods (see AUTH METHODS below)
  [ ] "Build first, sign later" UX fix (see PUBLISH FLOW below)
  [ ] Forget identity button
  [ ] User collection / "my tickets" page
  [ ] Profile page
  [ ] Frontend export / portable hosting (packages/site-builder)
  [ ] Embed widget (packages/embed)
  [ ] Para wallet integration (post-v1, replaces local account option)

  CURRENT PRIORITIES (v1 launch):
  1. Auth overhaul — three login methods working
  2. "Build first, sign later" — deferred signing at publish time
  3. Forget identity — clear local account + stored EIP-712s
  4. Polish + deploy

  POST-V1 ROADMAP:
  - Para wallet integration (replaces local account as option 2)
  - Automated webhook relay (server-side, opt-in, different trust model)
  - Frontend export: user can port/host their event elsewhere
  - Customisable frontend / site builder (packages/site-builder)
  - Embed widget (packages/embed)

  SWARM CONFIG:
  - Frontend Bee gateway: https://gateway.woco-net.com
  - Backend Bee (local): http://192.168.0.144:3323
  - Postage batch: 10385383779bc425047a1c9023fdb86b6873136ecccd52df9c10251c0991088b
  - Feed private key: env FEED_PRIVATE_KEY (server-only, never expose)
  - .env file location: apps/server/.env

  SWARM PATTERNS:
  - All feed data uses 4096-byte binary pages (128 slots x 32 bytes)
  - pack4096/decode4096 for reference arrays
  - JSON feeds pad to 4096 bytes with null bytes
  - Topic naming: woco/{domain}/{entity}/{id}
  - Platform signer owns all feeds (single private key) - centralized for now
  - Retry with exponential backoff for feed propagation delays
  - bee-js response format varies by version - always use toBytes() helper

  FEED TOPICS:
  woco/event/directory                    # Global event listing (JSON feed)
  woco/event/{eventId}                    # Event details + ticket series (JSON feed)
  woco/pod/editions/{seriesId}            # Page 0: slot 0=metadata, slots 1-127=tickets
  woco/pod/editions/{seriesId}/p{N}       # Pages 1+: 128 tickets per page
  woco/pod/claims/{seriesId}              # Page 0: mirrors editions layout
  woco/pod/claims/{seriesId}/p{N}         # Pages 1+: mirrors editions pages
  woco/pod/claimers/{seriesId}            # Who claimed what (JSON feed)
  woco/pod/collection/{ethAddress}        # User's claimed tickets (JSON feed)
  woco/pod/creator/{creatorPodKey}        # Creator's event/series index

  MULTI-PAGE EDITION FEEDS:
  - Page 0 capacity: 127 tickets (slot 0 = metadata ref)
  - Page N capacity: 128 tickets (no metadata slot)
  - Total capacity: 127 + (N-1) * 128 per series
  - Claims feeds mirror editions layout exactly
  - Metadata ref (page 0, slot 0) includes { pageCount, totalSupply }
  - editionPageCount() helper in topics.ts calculates pages needed
  - No arbitrary limit on ticket quantity

  ============================================================================
  AUTH METHODS (3 login options)
  ============================================================================

  The sign-in popup offers three methods. All three produce the same
  downstream result: a parent address, a session key, and a POD identity
  (ed25519). The backend doesn't care which method was used — it only
  verifies the EIP-712 session delegation.

  OPTION 1: Web3 Wallet (MetaMask, etc.)
  - User clicks "Connect Wallet" → browser wallet popup (connect only)
  - Parent key = wallet's secp256k1 account
  - Session delegation: wallet signs EIP-712 "AuthorizeSession"
  - POD identity: wallet signs EIP-712 "DerivePodIdentity" → deterministic ed25519
  - Existing flow, works today

  OPTION 2: Local Browser Account (v1, replaces Para wallet)
  - User clicks "Create Local Account"
  - Frontend generates a random secp256k1 keypair
  - Private key stored in IndexedDB (AES-GCM encrypted with device key)
  - This IS the parent key — acts identically to a web3 wallet
  - Session delegation: frontend signs EIP-712 locally (no MetaMask popup)
  - POD identity: frontend signs EIP-712 locally → deterministic ed25519
  - Persists across browser sessions (survives refresh/close)
  - "Forget identity" button wipes the key + all stored EIP-712s
  - Reference: devconnect-profile-sandbox (woco.eth.limo live app)
  - Post-v1: Para wallet replaces this option (managed wallet service)

  OPTION 3: Zupass Login
  - User clicks "Sign in with Zupass" → Zupass OTP flow
  - No ethereum account needed — Zupass provides ed25519 directly
  - The Zupass ed25519 IS the POD identity (no derivation step)
  - Session delegation: needs adapter (Zupass signs differently)
  - For event creation: ed25519 signs tickets directly
  - Reference: partially working in woco.eth.limo live app
  - Key difference: Zupass users skip all EIP-712 signing

  LOCAL ACCOUNT EIP-712 SIGNING:
  - Local accounts don't have MetaMask, so we sign EIP-712 in-browser
  - Use ethers.Wallet(privateKey).signTypedData() directly
  - Must show a confirmation popup so the user sees what they're signing
  - Popup shows: domain, action description, key fields
  - User clicks "Sign" or "Cancel"
  - Same popup used for both session delegation and POD identity derivation

  FORGET IDENTITY:
  - Button in UI (similar to live woco.eth.limo app)
  - Clears from IndexedDB: local account private key, session key,
    session delegation, POD seed, auth kind, parent address
  - Does NOT clear: webhook configs, sent tracking (those are per-event)
  - After clearing, user returns to signed-out state

  ============================================================================
  AUTH PATTERN (EIP-712 Session Delegation)
  ============================================================================

  - User authenticates via one of the three methods above
  - Frontend generates random session key (secp256k1)
  - Parent signs EIP-712 "AuthorizeSession" delegating to session key
    (via MetaMask for web3, via local signing for local account)
  - All API requests include session delegation (message + parentSig)
  - Backend verifies: signature valid, not expired, session address matches
  - Domain: { name: "WoCo Session", version: "1" }
  - Types: AuthorizeSession with fields: host, parent, session, purpose,
    nonce, issuedAt, expiresAt, sessionProof, clientCodeHash, statement

  THREE IDENTITY LAYERS:
  1. Primary wallet (secp256k1) - permanent identity, owns profile
     (web3 wallet OR local browser account — same type, different source)
  2. Session key (secp256k1, random) - ephemeral, signs API requests
  3. POD identity (ed25519, deterministic) - signs tickets, proves ownership
     (derived from EIP-712 for wallet/local, native for Zupass)
  - Two SEPARATE EIP-712 signatures required (cannot be combined):
    - Session delegation: random nonce (per-session)
    - POD identity: fixed nonce "WOCO-POD-IDENTITY-V1" (deterministic)
  - Exception: Zupass users skip EIP-712 entirely, ed25519 comes from Zupass

  POD KEY DERIVATION:
  - EIP-712 sig with fixed nonce → keccak256 → 32-byte seed → ed25519 keypair
  - Deterministic: same wallet always derives same POD key
  - Library: @noble/ed25519
  - Domain: { name: "WoCo POD Identity", version: "1" }
  - Type: DerivePodIdentity { purpose, address, nonce }
  - Zupass: no derivation — ed25519 provided directly by Zupass

  ============================================================================
  PUBLISH FLOW ("Build first, sign later")
  ============================================================================

  Design principle: users fill the entire event creation form BEFORE any
  wallet popups or signing. Signing happens only at publish time.

  Current state (BROKEN):
  - Sign-in button at top triggers MetaMask immediately
  - Publish button stays disabled if not signed in
  - No prompt to sign in when user tries to publish

  Target flow:
  1. User fills event form (title, date, series, images, order fields)
  2. User clicks "Publish"
  3. If not signed in → auth popup appears (pick method: web3/local/zupass)
  4. After auth → session delegation EIP-712 (auto for local, MetaMask for web3)
  5. After session → POD identity EIP-712 (auto for local, MetaMask for web3)
     (Zupass: steps 4+5 replaced by Zupass OTP flow)
  6. After POD identity → event publishes to Swarm
  7. If already signed in → skip steps 3-5, publish immediately

  Sign-in button (top-left):
  - Always visible, shows "Sign in" or connected address
  - Clicking opens auth method picker popup
  - Optional — user can sign in early if they want
  - Should NOT trigger EIP-712 signing — just connects/creates account
  - EIP-712 signing deferred to first action that needs it (publish, claim)

  ============================================================================
  TICKET SYSTEM
  ============================================================================

  - Series = event ticket type (has totalSupply, metadata, image)
  - Editions = individual tickets (signed by creator's ed25519 key)
  - Simple ed25519 signing (no @pcd/pod dependency)
  - Ticket format: woco.ticket.v1
  - Claimed format: woco.ticket.claimed.v1

  Unclaimed ticket (signed by event creator):
    podType: "woco.ticket.v1"
    eventId, seriesId, seriesName, edition, totalSupply, imageHash
    creator: ed25519 public key (hex)
    mintedAt: ISO timestamp
    → Signed with creator's ed25519 private key

  Claimed ticket (created by platform at claim time):
    podType: "woco.ticket.claimed.v1"
    All fields from unclaimed + owner (claimer podkey),
    ownerAddress, claimedAt, originalPodHash, originalSignature
    → v1: platform creates claim record (no claimer signing yet)
    → v2: claimer signs with own ed25519 key for full decentralization

  CLAIMING FLOW:
  1. User views event detail, sees "Claim ticket" button per series
  2. Click triggers: auth (if needed) → POD identity → claim API call
  3. Backend finds next unclaimed edition (scans claims feeds across pages)
  4. Backend downloads original signed ticket, creates claimed version
  5. Uploads claimed ticket to /bytes, writes hash to claims feed slot
  6. Updates claimers feed (JSON) and user collection feed (best-effort)
  7. Frontend shows green "Claimed #N" badge

  ============================================================================
  WEBHOOK RELAY (Organizer Dashboard)
  ============================================================================

  - Server: POST /api/events/:id/webhook-relay (authenticated, organizer-only)
  - SSRF protection: HTTPS-only, blocks private/loopback IPs
  - Rate limit: 30 req/min per parentAddress (in-memory)
  - Payload limit: 64KB, response truncated to 4KB
  - Server never stores/logs payload — only eventId + target hostname + status
  - Frontend: webhook config stored in localStorage per event
  - Sent tracking: localStorage per event, persists across reloads
  - Manual flow: organizer reviews decrypted orders, clicks Send
  - Bulk send: sequential with 200ms delay between requests
  - Future: opt-in automated mode (server stores webhook creds + decryption key)

  FRONTEND AUTH STORAGE (IndexedDB "woco:idb"):
  woco:auth:kind              # "web3" | "local" | "zupass" | "none"
  woco:auth:session-key       # AES-GCM encrypted session private key
  woco:auth:session-delegation # Encrypted delegation bundle
  woco:auth:parent            # Parent wallet address
  woco:auth:pod-seed          # POD identity seed (hex)
  woco:auth:local-key         # AES-GCM encrypted local account private key (local only)
  woco:device-key             # SubtleCrypto device key for encryption

  UI/UX:
  - Dark theme with CSS custom properties (app.css)
  - Accent color: warm violet (#7c6cf0)
  - Luma-inspired: clean cards, subtle hover effects, backdrop blur
  - "Build first, sign later" UX: users fill forms before wallet popups
  - Hash-based routing: #/ (home), #/create (form), #/event/:id (detail)
  - Responsive grid for event cards

  HONO SERVER TYPING:
  - AppEnv type in src/types.ts defines context variables
  - Use Hono<AppEnv> and Context<AppEnv> for typed c.get()/c.set()
  - SESSION_TYPES needs cast: SESSION_TYPES as unknown as Record<string, TypedDataField[]>
  - bee-js Bytes type needs: result as unknown as Record<string, unknown>

  CENTRALIZED ELEMENTS (to phase out later):
  - Platform feed signer (FEED_PRIVATE_KEY) → users get own feed signers
  - Backend as Swarm relay → frontend talks to Swarm directly
  - Claims via backend → smart contracts or direct Swarm writes
  - Feed topics use UUIDs for uniqueness under shared signer (no collisions)

  KEY DEPENDENCIES:
  - @ethersphere/bee-js (Swarm client)
  - ethers (EIP-712 signature verification + local account signing)
  - @noble/ed25519 + @noble/hashes (ed25519 signing, key derivation)
  - hono + @hono/node-server (backend framework)

  CONVENTIONS:
  - TypeScript strict mode everywhere
  - Shared types in packages/shared (single source of truth)
  - Environment variables: VITE_ prefix for frontend, plain for server
  - API responses always include { ok: boolean, error?: string }
  - Lowercase eth addresses for deterministic feed topics
  - Hex strings: no 0x prefix for Swarm refs (Hex64), 0x prefix for eth (Hex0x)
  - CSS: use var(--token) from app.css, never hardcoded hex in components
  - Server .env at apps/server/.env (gitignored)

  DEV COMMANDS:
  npm run dev:web        # Vite dev server on :5173
  npm run dev:server     # tsx watch on :3001
  npm run build:web      # Production build
  npm run build:server   # TypeScript check

  KEY FILES FOR AUTH WORK:
  apps/web/src/lib/auth/auth-store.svelte.ts   # Main auth state + signRequest()
  apps/web/src/lib/auth/pod-identity.ts        # POD key derivation + restore
  apps/web/src/lib/components/auth/WalletLogin.svelte  # Current login UI
  apps/web/src/lib/components/auth/SessionStatus.svelte # Top-bar auth status
  apps/web/src/lib/components/events/PublishButton.svelte # Publish trigger
  apps/server/src/middleware/auth.ts            # Backend delegation verification
