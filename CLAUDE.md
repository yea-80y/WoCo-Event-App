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

DEPLOYMENT:
- Backend server: 192.168.0.144 (user: ntl-dev), dir: ~/woco-events-server
- Frontend: Swarm feed via gateway.woco-net.com AND woco.eth.limo (ENS)
- API: events-api.woco-net.com (Cloudflare tunnel → :3001)

PRODUCTION ENV (`apps/server/.env`):
- apps/server/.env ON THIS LAPTOP is master — synced to server every deploy
- ALLOWED_HOSTS must include every frontend host (gateway.woco-net.com, etc.)
- BEE_URL=http://192.168.0.144:3323 (same address for laptop + server)
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
- Backend Bee (local): http://192.168.0.144:3323
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
