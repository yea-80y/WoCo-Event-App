WoCo App — decentralised event platform on Swarm + Ethereum.

Running history of completed work and the Devcon/EF roadmap lives in `docs/DEVLOG.md`.
Cryptographic audit + fix rounds: `docs/CRYPTO_AUDIT_2026-04-08.md`, `docs/SECURITY_FIXES_2026-04-09.md`.

============================================================================
STACK & STRUCTURE
============================================================================

- Frontend: Vite + Svelte 5 (runes) + TypeScript — `apps/web`
- Backend:  Hono + TypeScript — `apps/server`
- Storage:  Swarm feeds (no database)
- Auth:     EIP-712 session delegation (wallet → session key)
- Monorepo: npm workspaces

apps/web/              # Vite + Svelte main platform UI
apps/server/           # Hono API server (Swarm relay + auth)
packages/shared/       # Shared types, POD schema, constants (single source of truth)
packages/embed/        # <woco-tickets> Web Component (IIFE ~71KB)
packages/site-builder/ # Static site generator for organiser events
contracts/             # WoCoEscrow.sol + deploy scripts

============================================================================
DEV & DEPLOYMENT
============================================================================

DEV COMMANDS:
  npm run dev:web        # Vite dev server :5173
  npm run dev:server     # tsx watch :3001
  npm run build:web      # production frontend build
  npm run build:server   # tsc typecheck + build
  npm run build:embed    # IIFE bundle → packages/embed/dist/woco-embed.js
  npm run build:site     # generated-site build → apps/web/dist-site/

DEPLOYMENT (Hetzner CPX22, migrated 2026-05-19 — see docs/HETZNER_DEPLOY.md):
- Backend: Hetzner CPX22 VM at 46.225.174.72 (user: root, dir: /opt/woco), Docker Compose 3-service stack
  (bee + bee-proxy + server). Connect: `ssh root@46.225.174.72` (key on laptop `~/.ssh/id_ed25519`).
- Frontend: Swarm feed via gateway.woco-net.com AND woco.eth.limo (ENS)
- API: events-api.woco-net.com (host cloudflared → 127.0.0.1:3001 server)
- Gateway: gateway.woco-net.com (host cloudflared → 127.0.0.1:3000 bee-proxy)
- Old laptop-server (192.168.0.144) is DECOMMISSIONED but kept cold for 2-week rollback until 2026-06-02.
  Containers removed, compose file renamed. See docs/LAPTOP_BEE_EMERGENCY_RESURRECTION.md for rollback.

SERVER DEPLOY (Hetzner — much simpler than the old kill-and-restart laptop flow):
- apps/server/.env on THIS LAPTOP is master. Mirrored to /opt/woco/server.env on the VM.
- Server code update (1 command from laptop, 1 command on VM):
    rsync -az --exclude=node_modules --exclude=.git --exclude=dist \
      --exclude=apps/web/dist-site --exclude=apps/web/dist-multisite \
      --exclude=packages/embed/dist \
      ~/projects/woco_app/ root@46.225.174.72:/opt/woco/repo/
    ssh root@46.225.174.72 'cd /opt/woco && docker compose up -d --build server'
- Env update:
    scp ~/projects/woco_app/apps/server/.env root@46.225.174.72:/opt/woco/server.env
    ssh root@46.225.174.72 'sed -i "s|^BEE_URL=.*|BEE_URL=http://bee-node:1633|" /opt/woco/server.env && sed -i "s|^PROXY_URL=.*|PROXY_URL=http://bee-proxy:3000|" /opt/woco/server.env && cd /opt/woco && docker compose restart server'
- Logs: `ssh root@46.225.174.72 'cd /opt/woco && docker compose logs -f --tail 50 server'`
- Verify: `curl https://events-api.woco-net.com/api/health` (HTTPS only — no LAN IP path anymore)
- No PID hunting, no nohup, no duplicate-process worries — docker compose handles lifecycle.

PRODUCTION ENV (`apps/server/.env`):
- apps/server/.env ON THIS LAPTOP is master — synced to server every deploy
- ALLOWED_HOSTS must include every frontend host (gateway.woco-net.com, etc.)
- BEE_URL: laptop master keeps LAN IP, but the scp deploy step rewrites it to `http://bee-node:1633`
  (in-docker DNS) on the VM. Don't edit the VM copy directly — it'll be overwritten on next deploy.
- EMAIL_HASH_SECRET must be set (HMAC key for email hashing — without it falls back to
  unsalted SHA-256). Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- PAYMENT_QUOTE_SECRET must be set (HMAC key for signed payment quotes). Same generator.
  Without it, /api/payment/quote cannot sign and all crypto claims will fail.
- STRIPE_WEBHOOK_SECRET (connect-account events) + STRIPE_WEBHOOK_SECRET_PLATFORM
  (platform events like account.updated). Both required in production.

============================================================================
AUTH ARCHITECTURE
============================================================================

Three identity layers:
1. Primary wallet (secp256k1) — permanent identity
2. Session key (secp256k1, random, 30-day expiry) — signs API requests
3. POD identity (ed25519, deterministic) — signs tickets + derives encryption key

Login methods (all working):
- Web3 wallet (MetaMask, WalletConnect)
- Local browser account (secp256k1 in IndexedDB, AES-GCM encrypted)
- Para embedded wallet (email → hosted iframe → EVM wallet, MPC)
- Zupass — NOT YET (needs ed25519 adapter)

Deferred signing: login just connects; EIP-712 `AuthorizeSession` is signed on first
action that needs it (publish, claim, MyTickets). `ensureSession()` is the gate.
`ensurePodIdentity()` runs on publish AND first dashboard decrypt.

Global login popup pattern: `loginRequest.request() → Promise<boolean>` — opens
`LoginModal` from any component. Used by ClaimButton, PublishButton, MyTickets, nav.

CANONICAL REQUEST SIGNING (auth v2, 2026-04-09):
Client signs, server verifies, the canonical challenge:

  woco-session-v1\n{METHOD}\n{path}\n{timestamp}\n{nonce}\n{sha256(rawBody)}

Signed EIP-191 by the session key. Server rebuilds the challenge from
`c.req.text()` (raw body bytes — no parse/re-stringify) and `verifyMessage`s it.
Timestamp window ±5 min. All auth material lives in headers:
  X-Session-Address | X-Session-Delegation (b64 JSON) | X-Session-Sig | X-Session-Nonce | X-Session-Timestamp

Session revocation: `POST /api/auth/revoke-session` (single nonce) or
`/api/auth/revoke-all` (all sessions for parent before now). State in
`.data/revoked-sessions.json`.

============================================================================
SWARM
============================================================================

- Frontend Bee gateway: https://gateway.woco-net.com (dev) / gateway.ethswarm.org (generated prod sites)
- Backend Bee (in-cluster on Hetzner): http://bee-node:1633 (internal docker DNS, set as BEE_URL on the VM)
  Laptop dev master still has BEE_URL pointing at LAN; the deploy step rewrites it (see deploy section above).
- Postage batch: `POSTAGE_BATCH_ID` (server-only)
- Feed private key: `FEED_PRIVATE_KEY` (server-only; platform signer owns all feeds — centralised for now)

PATTERNS:
- Feed data = 4096-byte binary pages (128 slots × 32 bytes)
- JSON feeds pad to 4096 with null bytes
- Topic naming: `woco/{domain}/{entity}/{id}`
- Retry with exponential backoff for feed propagation delays

FEED TOPICS:
  woco/event/directory                    # Global event listing
  woco/event/{eventId}                    # Event details + ticket series
  woco/event/creator/{ethAddress}         # Per-organiser event index (never deleted from)
  woco/pod/editions/{seriesId}[/p{N}]     # Tickets, 128 per page
  woco/pod/claims/{seriesId}[/p{N}]       # Mirrors editions
  woco/pod/claimers/{seriesId}            # Who claimed what
  woco/pod/collection/{ethAddress}        # User's collection
  woco/pod/pending-claims/{seriesId}      # Approval queue
  woco/profile/data/{ethAddress}          # User profile
  woco/profile/avatar/{ethAddress}        # Avatar ref (separate feed → independent updates)
  woco/registry/verified-frontends        # [planned] content hash registry

============================================================================
TICKET / PAYMENT / CLAIM FLOW
============================================================================

TICKETS:
- Series = event ticket type (`totalSupply`, metadata, image)
- Editions = individual tickets, signed by creator's ed25519 key
- Formats: `woco.ticket.v1` / `woco.ticket.claimed.v1`
- Always-on encryption: every claim encrypts `seriesId + claimerAddress/Email` for
  organiser dashboard, even without order form fields

CLAIMS:
- Wallet: requires session delegation + per-request canonical sig
- Email:  unauthenticated, rate-limited 3/15min per IP; email stored as HMAC-SHA256
- Passkey / wallet-signed: EIP-191 signed message, no session delegation needed
- Server uses the VERIFIED parentAddress, never an address from the request body
- Double-spend prevention: in-flight lock + per-series async queue serialises writes

APPROVAL FLOW:
- Series flag `approvalRequired: true` at creation
- Claim returns `{ approvalPending: true, pendingId }` instead of a ticket
- Slot reserved immediately (prevents double-assign on concurrent approvals)
- `GET /api/events/:id/pending-claims` — organiser queue (header auth)
- `POST .../pending-claims/:pendingId/approve|reject`
- ClaimButton shows "Request to attend" / amber "Pending Approval" badge
- `GET /claim-status` returns `userPendingId` (pending) or `userEdition` (approved)

UNIFIED PRICING MODEL:
- Organiser sets ONE fiat price (GBP/USD/EUR) + toggles cryptoEnabled/stripeEnabled
- PaymentConfig: { price, currency(FiatCurrency), recipientAddress, acceptedChains,
  escrow, cryptoEnabled, stripeEnabled }
- Crypto amounts converted from fiat at claim time (forex → USD → ETH via CoinGecko)

CRYPTO PAYMENTS (ETH + USDC on Base/Optimism/Mainnet/Sepolia):
- Escrow (`WoCoEscrow.sol`, time-locked) or direct transfer
- SIGNED QUOTE FLOW (Phase 1, 2026-04-18 — canonical): client MUST fetch
  `POST /api/payment/quote` first. Server returns HMAC-SHA256-signed
  `PaymentQuote` committing to exact `amountWei`. Client pays EXACTLY that
  wei; server verifies by exact-match against `tx.value`. Eliminates the
  client/server oracle race that caused slippage failures.
- Quote TTL: 180s, one-shot (consumed on successful claim via
  `.data/consumed-quotes.json`). `PAYMENT_QUOTE_SECRET` env required.
- Server verifies on-chain: tx hash + chain + amount (exact) + recipient + confirmations + `tx.from`
- Per-chain confirmation thresholds: mainnet=12, L2s=3
- Confirmation wait uses `provider.waitForTransaction()` (not receipt math —
  RPC head-skew caused false rejections)
- txHash replay prevention: file-backed Set in `.data/consumed-tx-hashes.json`
- Payment→claimer binding: `tx.from` MUST match the authenticated claimer.
  Wallet mode: bound to verified `parentAddress`.
  Email/passkey: client must include `claimerProof` — EIP-191 sig by the paying
  wallet over `woco-payment-v1:{txHash}:{eventId}:{seriesId}:{identifier}`.
  Without this, an attacker could front-run any pending payment from the mempool.
- Payment proof saved to `sessionStorage` before claim (recovery if claim fetch fails)
- Phase 2 (future): atomic mint contract — single tx reverts payment + mint
  together. Design doc: `docs/PAYMENTS_PHASE_2.md` (recommends Option A:
  on-chain quote commitment + self-serve refund; Option B/NFT mint is end-state)

STRIPE PAYMENTS (Card via Stripe Connect):
- Stripe Connect Express accounts, hosted onboarding (Account Links)
- Destination charges: WoCo platform collects, transfers to organiser minus fee
- Platform fee: 1.5% (application_fee_amount) — matches escrow contract (150 bp)
- Stripe fee on top (paid by organiser from their cut):
  UK/EU cards ~2% + 20p, international ~3.75% + 20p (includes Connect +0.5%)
- Account store: `.data/stripe-accounts.json` (file-backed, same pattern as tx-registry)
- Webhook: checkout.session.completed auto-claims ticket via claimTicket()
  Webhook source: "Connected and v2 accounts" (NOT "Your account")
- Onboarding opens in NEW TAB during event creation to preserve form data
- Frontend modal checks auth, prompts WoCo login if needed before Stripe API calls
- Passkey/any user can pay by card; wallet users can also choose card
- STRIPE_WEBHOOK_SECRET must be set for production signature verification
- Dual webhook secret: both the platform webhook (checkout.session.completed) and the
  connected-accounts webhook (account.updated + checkout.session.completed) point to the
  same URL. STRIPE_WEBHOOK_SECRET_PLATFORM is the platform signing secret;
  STRIPE_WEBHOOK_SECRET is the connect-account signing secret. Route tries both.
  constructEvent tolerance is 3600s (1 hour) so Stripe retries succeed even if the
  first delivery timed out. Session ID replay prevention (.data/consumed-stripe-sessions.json)
  ensures each checkout.session.completed is processed exactly once.
- Production rejects unsigned webhooks (prevents forged free-ticket claims)
- Pre-flight check on /api/stripe/create-checkout: returns 409 if sold out
  or user already has a ticket (prevents charge-without-ticket race)
- Auto-refund on claim failure for unrecoverable reasons (Already claimed,
  No tickets available, Series not found); transient failures skipped

STRIPE UX — PHASE 2 (2026-04-24, latency pass for email-only claims):
- `/create-checkout` accepts optional raw `encryptedOrder`; when no pre-uploaded
  `orderRef` is passed, the SealedBox upload to Swarm runs in parallel with
  `getEvent` + `getClaimStatus` via `Promise.all` so Swarm latency hides behind
  the pre-flight reads. Client pre-upload still takes priority.
- Client pre-uploads the SealedBox to `/prepare-order` 700ms (debounced) after
  the form becomes valid — `pendingOrderRef` is passed on Pay click making the
  redirect near-instant. Orphan refs on field edits are harmless (encrypted,
  unreachable, one postage slot each).
- Order form opens ⇒ `$effect` refreshes availability immediately. Amber
  "Only N left" pill when ≤5, red sold-out / quantity-shortfall banner
  disables the Pay button before the user commits.
- Pay button shows a 2px hairline shimmer while pre-upload is mid-flight;
  button stays clickable — create-checkout falls back to inline upload.
- Optimistic success card on Stripe return: shows "Payment confirmed — Your
  ticket is on its way to X@Y.com" immediately, no polling, no spinner, no
  QR, no edition number, no MyTickets reference. Persisted to
  sessionStorage so page refresh within the tab keeps it visible.
- Designed for standalone ENS site-builder events where users are email-only
  (no wallet, no POD identity, no MyTickets account) — the email IS the
  delivery channel, so the UI matches that mental model.

STRIPE UX — PHASE 3 (2026-04-25, slot reservations + composite ticket card):
- Slot reservation: order-form open POSTs `/api/reservations/reserve`
  (~10min TTL); Pay passes `reservationId` to `/create-checkout`; webhook
  consumes it. File-backed `.data/reservations.json`, per-series mutex.
  Frontend countdown pill, quantity-change re-issues, `pagehide` fires
  `navigator.sendBeacon` for release. No Swarm writes.
- Pre-upload widened: 250ms → 1500ms idle, with Pay-button hover/focus
  accelerator (`onpointerenter`/`onfocus`/`ontouchstart` → upload now).
- Composite ticket card replaces basic QR PNG + slow eth.limo verify link.
  Two new user-facing routes (no `/api` prefix):
    GET /t/{eventId}/{seriesId}/{edition}/{sig}[.png]
  PNG route uses Hono regex `:sig{.+\\.png}` BEFORE the HTML catch-all.
  `?n=` / `?e=` are display-only; cryptographic guarantee is the path sig.
- Renderer: `lib/ticket/render-card.ts` builds SVG → 800×1100 PNG via
  `@resvg/resvg-js` (pure WASM). QR drawn as `<rect>` matrix (no image-href).
  `loadSystemFonts: true` + DejaVu Sans (installed on Arch + Ubuntu).
- Email attaches PNG via `cid:woco-card-N` and links the HTML page.
  Stripe webhook passes `session.customer_details?.name` as `buyerName`.
- `PUBLIC_API_BASE` env required for absolute email URLs.

STRIPE UX — PHASE 3 HARDENING (2026-04-28, reservation hardening + earlier trigger):
- Per-browser dedup: `X-Client-Key` header (UUID from localStorage); on every
  /reserve, the store atomically releases this browser's other active holds on
  the same series before allocating. Closes the stale-hold window after tab
  close / sessionStorage loss. Header CORS-allowed in `apps/server/src/index.ts`.
- Per-IP cap: `RESERVATION_MAX_SEATS_PER_IP=30` across all series; route-level
  rate limit 30/min/IP. Bounds floods that clientKey rotation could otherwise
  bypass.
- Late-consume in webhook: `consumeReservation()` runs AFTER all per-batch
  claims commit, not at webhook entry. Reason: claiming N tickets is sequential
  through the per-series mutex, each claim is a slow Swarm write; consuming
  up front would drop heldFor() to 0 mid-batch and let concurrent buyers
  reserve the same physical slots. Hold persists for the full webhook duration.
- Partial refund: if some tickets in a batch claimed but the rest hit an
  unrecoverable error, refund only the unfilled portion pro-rata against
  `amount_total`. Zero-claimed batches still refund the full intent. Prevents
  clawing back tickets the buyer already received.
- Earlier trigger for email-only events: `claimMode === "email"` (site-builder /
  standalone-ENS path) fires the reservation on ClaimButton mount — i.e. when
  the buyer clicks "Get tickets" and the fees box renders, before the order
  form opens. `claimMode === "both"` keeps the deferred trigger (form-open
  with `stripeAfterForm=true`) so wallet-path buyers don't hold a Stripe seat.
  Pill + error banner moved above the if/else cascade in ClaimButton so the
  hold is visible in both pre-form fees view and the open form.
- Same-clientKey return-existing: re-issuing /reserve from the same browser
  with the same quantity (no `replaceReservationId`) returns the EXISTING hold
  unchanged — TTL preserved. Closing + reopening the tab no longer restarts
  the 10-min countdown, so a buyer can't extend a lock indefinitely.
- Sold-out vs held-by-other UX: server returns both `available` (effective,
  may be 0 when others hold all remaining) AND `physicalAvailable` (totalSupply
  - claimed). Frontend distinguishes "Sold out" from "All remaining held by
  other buyers — try again in a few minutes" from "Only N available".
- No release on tab close / unmount: pagehide listener and onDestroy release
  removed from ClaimButton. Reservation TTL is the buyer's window; closing
  and reopening should resume the same hold (clientKey lookup), not restart
  it. Releases still fire on qty→0 and form-close in claimMode==="both".
- EventPage qty dropdown shows `max(0, available - held)` so other buyers
  see the hold reflected immediately. Note: subtracts buyer's own held qty
  too — minor cap on the same buyer increasing their own qty without refresh,
  acceptable trade-off for clearer cross-buyer UX.

============================================================================
MULTI-PAGE SITE BUILDER
============================================================================

Builder UI lives at `#/build` inside the main WoCo app (App.svelte routes to it).
Deployed sites are standalone BZZ collections on Swarm — no server at runtime.

SCHEMA (packages/shared/src/site/types.ts):
- `Site` — top-level config: theme, pages, nav, contact, socials, siteId (ULID)
- `ThemeTokens` — brandName, logoSwarmRef, siteDescription (SEO), palette, font, radius
- `Page` — slug, title, metaDescription, sections[]
- `Section` — discriminated union: hero | richText | gallery | eventsGrid | featuredEvent |
  openingHours | map | contactForm | embed
- `SiteEventsIndex` — {siteId, events: SiteEventEntry[], updatedAt}
- `SiteDirectoryEntry` — compact entry in creator's site directory feed
- `SiteDirectory` — paged on-feed envelope (mirrors EventDirectory pattern)
- `SiteRuntimeConfig` — injected as window.SITE_CONFIG at deploy time

FEEDS:
- woco/site/config/{siteId}           → Site JSON (config + theme + pages)
- woco/site/{siteId}/events           → SiteEventsIndex (event IDs + featured flags)
- woco/site/creator/{ethAddress}[/pN] → Creator's site directory (SiteDirectory, paged)
- woco-multisite-{siteId}             → per-site feed → latest BZZ content hash (for ENS)

AUTH: all write endpoints (publish, deploy, events, contact) require auth via the same
EIP-712 session delegation used by events. Owner is stamped server-side from the verified
parentAddress — creator's crypto account is the authoritative identity.

PUBLISH FLOW (two-step):
1. POST /api/sites → writes Site + SiteEventsIndex feeds atomically; upserts SiteDirectoryEntry
   into creator's directory feed (woco/site/creator/{ethAddress})
2. POST /api/sites/:id/deploy → injects SITE_CONFIG + SEO/PWA meta, tars dist-multisite/,
   uploads BZZ collection, writes content hash to per-site feed, auto-whitelists hashes on
   gateway, re-upserts directory entry with feedHash + deployedUrl.
   Returns { contentHash, feedManifestHash, siteUrl }

MY SITES DASHBOARD:
- GET /api/sites/mine — auth-gated, reads creator's Swarm directory, returns SiteDirectoryEntry[]
- Builder opens on "Your websites" landing screen (MySitesScreen.svelte) showing site cards
- Cards seeded from localStorage (instant) then merged with API results (authoritative)
- LocalStorage key woco:my-sites is a write-through cache; API is source of truth
- "← My Sites" back button in builder header; "Load from another device" advanced toggle
  for cross-device recovery via Site ID

EVENT LOADING (deployed site):
- GET /api/sites/:id/events-full — bundled endpoint, 5-min server-side cache + Cache-Control
  headers for Cloudflare edge caching. Client uses 2h stale-while-revalidate localStorage cache.
- Preview mode (window.SITE_CONFIG.previewEvents set): skips cache, fetches individually.

SEO:
- siteDescription (ThemeTokens) injected at deploy time: <meta name=description>,
  og:title/description/image, twitter:card. ogImage = logo Swarm ref.
- MultiSiteApp updates <meta name=description> per-page at runtime.

TEMPLATE PRESET: pub-venue-v1 (only one so far). newSiteFromTemplate() in shared.

KNOWN GOTCHAS (site builder):
- build:multisite → dist-multisite/ (NOT build:site → dist-site/). Server deploy endpoint
  reads DIST_MULTISITE_PATH; must rsync apps/web/dist-multisite/ before first deploy.
- GET /api/sites/mine must be registered BEFORE /:id in Hono or "mine" matches as a siteId.
- Creator directory upsert is fire-and-forget on both publish and deploy — non-fatal.
- events-full has 5-min server-side Map cache per siteId; invalidated on server restart.
  Featured filtering uses the bundled index so no second fetch is needed.

============================================================================
CONVENTIONS
============================================================================

- TypeScript strict mode everywhere; shared types in `packages/shared`
- Env vars: `VITE_` prefix for frontend, plain for server
- API responses: `{ ok: boolean, data?: T, error?: string }`
- Addresses: lowercase for deterministic feed topics
- Hex: no `0x` prefix for Swarm refs (Hex64), `0x` prefix for eth (Hex0x)
- CSS: use `var(--token)` from `app.css`, never hardcoded hex
- Svelte 5 runes (`$state`, `$derived`, `$effect`) — no stores API
- Hono: `AppEnv` type in `src/types.ts`; `SESSION_TYPES as unknown as Record<string, TypedDataField[]>`

============================================================================
KEY FILE MAP
============================================================================

AUTH (frontend):
  apps/web/src/lib/auth/auth-store.svelte.ts         # main state machine + signRequest
  apps/web/src/lib/auth/login-request.svelte.ts       # global login popup trigger
  apps/web/src/lib/auth/signing-request.svelte.ts     # EIP-712 confirm dialog trigger
  apps/web/src/lib/auth/session-delegation.ts         # session key + delegation
  apps/web/src/lib/auth/pod-identity.ts               # ed25519 POD derivation
  apps/web/src/lib/auth/local-account.ts              # local browser account
  apps/web/src/lib/auth/para-{client,account}.ts      # Para SDK + flow
  apps/web/src/lib/auth/signers/{index,para-signer}.ts
  apps/web/src/lib/api/client.ts                      # authPost/authGet + buildAuthHeaders

AUTH (server):
  apps/server/src/middleware/auth.ts                  # session delegation + canonical sig verify
  apps/server/src/lib/auth/verify-delegation.ts       # EIP-712 verify + sessionProof + revocation
  apps/server/src/lib/auth/revocation.ts              # nonce blacklist + revoke-all

CLAIMS / EVENTS / PAYMENTS:
  apps/server/src/routes/claims.ts                    # claim endpoint + wallet auth + email rate limit
  apps/server/src/routes/events.ts                    # create / discover / list / unlist
  apps/server/src/routes/approvals.ts                 # approve/reject pending
  apps/server/src/routes/stripe.ts                    # Stripe Connect: onboarding, checkout, webhook
  apps/server/src/routes/reservations.ts              # slot reserve/release (Phase 3)
  apps/server/src/routes/ticket-page.ts               # /t/{...} HTML page + composite PNG (Phase 3)
  apps/server/src/routes/tickets.ts                   # email send (composite PNG + /t link)
  apps/server/src/lib/event/claim-service.ts          # core claim + approval logic
  apps/server/src/lib/event/service.ts                # event creation
  apps/server/src/lib/event/reservation-store.ts      # file-backed slot reservation (.data/reservations.json)
  apps/server/src/lib/ticket/render-card.ts           # SVG → 800×1100 composite PNG via resvg-js
  apps/server/src/lib/swarm/topics.ts                 # feed topic derivation
  apps/server/src/lib/payment/verify.ts               # on-chain ETH + USDC verification (waitForTransaction)
  apps/server/src/lib/payment/eth-price.ts            # fiat→USD→ETH conversion (forex + CoinGecko)
  apps/server/src/lib/payment/tx-registry.ts          # txHash replay prevention
  apps/server/src/lib/payment/quote.ts                # HMAC-signed PaymentQuote (Phase 1)
  apps/server/src/lib/payment/constants.ts            # per-chain confirmation thresholds
  apps/server/src/lib/stripe/client.ts                # Stripe SDK singleton
  apps/server/src/lib/stripe/accounts.ts              # organiser↔Stripe account mapping
  packages/shared/src/pod/verify.ts                   # ed25519 ticket signature verification

FRONTEND COMPONENTS:
  apps/web/src/App.svelte                             # shell: top bar + routing + bottom nav
  apps/web/src/lib/components/auth/{LoginModal,SigningConfirmDialog,ParaLogin}.svelte
  apps/web/src/lib/components/events/{ClaimButton,PublishButton,EventCard,EventDetail}.svelte
  apps/web/src/lib/components/passport/MyTickets.svelte
  apps/web/src/lib/components/dashboard/Dashboard.svelte
  apps/web/src/lib/components/dashboard/StripeConnect.svelte     # Stripe panel on dashboard
  apps/web/src/lib/components/dashboard/StripeConnectModal.svelte # modal for event creation
  apps/web/src/lib/components/embed/EmbedSetup.svelte
  apps/web/src/lib/components/profile/{ProfilePage,UserAvatar,CreatorChip,WalletTab,ConnectWalletModal}.svelte

MULTI-PAGE SITE BUILDER:
  apps/web/src/MultiSiteApp.svelte                              # deployed site runtime shell (hash router, theme)
  apps/web/src/lib/components/builder/MultiSiteBuilder.svelte   # builder UI — My Sites screen + editor tabs
  apps/web/src/lib/components/builder/MySitesScreen.svelte      # "Your websites" landing screen (site cards)
  apps/web/src/lib/components/builder/types.ts                  # MySiteRecord = SiteDirectoryEntry alias
  apps/web/src/lib/components/builder/tabs/BrandTab.svelte      # brand name, siteDescription, logo, palette
  apps/web/src/lib/components/builder/tabs/PagesTab.svelte      # page CRUD + metaDescription
  apps/web/src/lib/components/builder/tabs/NavTab.svelte        # nav item ordering
  apps/web/src/lib/components/builder/tabs/EventsTab.svelte     # pick organiser events for site
  apps/web/src/lib/components/builder/tabs/TemplateTab.svelte   # preset templates
  apps/web/src/lib/components/builder/SectionEditor.svelte      # per-section inline editor
  apps/web/src/lib/components/site/sections/EventsGridSection.svelte  # grid renderer (cached, bundled fetch)
  apps/web/src/lib/components/site/sections/FeaturedEventSection.svelte # single featured event (cached)
  apps/web/src/lib/components/site/sections/SectionRenderer.svelte  # dispatches to correct renderer
  apps/web/src/lib/api/sites.ts                                 # publishSite, deploySite, loadSite, getCreatorSites, getSiteEventsFull
  apps/server/src/routes/sites.ts                               # /api/sites/* — mine, publish, deploy, events-full, contact
  apps/server/src/lib/site/service.ts                           # getCreatorSites / upsertCreatorSite (Swarm directory)
  packages/shared/src/site/types.ts                             # Site, SiteDirectoryEntry, SiteDirectory, SiteEventsIndex
  packages/shared/src/site/templates.ts                         # newSiteFromTemplate (pub-venue-v1)
  packages/shared/src/site/topics.ts                            # siteConfigTopic / siteCreatorDirectoryTopic helpers
  apps/web/src/lib/cache/cache.ts                               # stale-while-revalidate localStorage cache (+ TTL.SITE_EVENTS)

PAYMENTS (frontend):
  apps/web/src/lib/api/stripe.ts                      # Stripe API client (connect, onboarding, checkout)
  apps/web/src/lib/api/payment.ts                     # fetchPaymentQuote (Phase 1 signed quote)
  apps/web/src/lib/api/reservations.ts                # reserve/release + countdown helpers (Phase 3)
  apps/web/src/lib/payment/{pay,chains,eth-price}.ts
  apps/web/src/lib/wallet/{provider,wc-provider,connection}.ts  # cached provider + disconnect/switch helpers

CONTRACTS (Foundry project — nested git repo at contracts/):
  contracts/src/WoCoEscrow.sol                        # time-locked escrow (ReentrancyGuard, 150bp fee)
  contracts/src/ContentHashRegistry.sol               # World Computer Registry (on-chain content hashes)
  contracts/script/Deploy.s.sol                       # escrow deploy
  contracts/script/DeployRegistry.s.sol               # registry deploy
  contracts/test/{WoCoEscrow,ContentHashRegistry}.t.sol

============================================================================
KNOWN GOTCHAS
============================================================================

BUILD / DEPLOY:
- `Vite base` must be `'./'` (relative) — absolute paths break under Swarm `/bzz/` URLs
- Upload script is `.cjs` (monorepo has `"type": "module"`)
- ALLOWED_HOSTS on server must include every frontend host or session delegation 403s
- apps/server/.env on laptop is master — IS synced to server on every deploy (overwrites)
- Server start script is `npm run start` (`node --import tsx src/index.ts`), NOT `node dist/index.js`
- After Bee restart, wait ~20s for peer warmup before deploying frontend
- Hono default 404 returns plain text "404 Not Found" — `authPost`'s `resp.json()`
  throws "Unexpected non-whitespace character at position 4". Consider a global 404 JSON handler.

SECURITY / AUTH:
- `EMAIL_HASH_SECRET` must be set before deploying — without it, emails are unsalted
  SHA-256 hashed (vulnerable to rainbow tables on public Swarm feeds)
- `POD_IDENTITY_DOMAIN` now includes a salt — changes the derived ed25519 key for any
  user who already published an event. Deploy `SESSION_DOMAIN` salt first; only deploy
  POD salt after confirming no active POD identities, or build a migration path
- Canonical challenge relies on raw body bytes: server MUST use `c.req.text()` BEFORE
  any parse/re-stringify, and the client must hash the exact bytes it sends
- `.data/consumed-tx-hashes.json`, `.data/revoked-sessions.json`, and
  `.data/consumed-stripe-sessions.json` MUST survive server restarts — loaded on
  startup. Don't delete them

SVELTE 5 / BEE-JS / PARA:
- Svelte 5 `$state` proxy: properties absent from initial object literal aren't reactive;
  always initialise ALL fields at declaration (e.g. `approvalRequired: false`, not omitted)
- bee-js v11: `writer.upload()` requires `new Reference(hexString)`, not a plain string;
  feed verification uses `feed.feedIndex` (not `feed.reference`, which no longer exists)
- Para SDK adds ~640KB (expected); "use client" warnings from Para are benign
- Para `wallet.address` is optional — always check presence, retry with backoff after
  `waitForLogin` / `waitForWalletCreation` resolves
- Para wallets filtered by type `"EVM"` when retrieving address (`para.wallets` is a
  `Record<string, Wallet>` — iterate with `Object.values()`)

STRIPE:
- `.data/stripe-accounts.json` MUST survive server restarts (same as tx-hashes, revoked-sessions)
- Stripe onboarding redirects go back to the Origin host — ALLOWED_HOSTS must include it
- Onboarding opens in new tab during event creation (preserves form state)
- Webhook endpoint: POST /api/stripe/webhook — needs raw body for signature verification
- Platform fee hardcoded in stripe.ts application_fee_amount — keep in sync with escrow contract

RUNTIME:
- Local account sign-out clears session but keeps keypair for re-login
- `MyTickets` triggers `ensureSession` on mount (lazy EIP-712), not just on login
- Embed widget wallet claims disabled — need session delegation support in the widget
- SESSION_DOMAIN has NO chainId — ALLOWED_HOSTS is the host security guard
- Web3 auth init: if wallet not immediately available after redirect, session restores
  from IndexedDB and wallet reconnects in background (10s retry). Prevents logout on
  external redirects (Stripe onboarding, etc.)
