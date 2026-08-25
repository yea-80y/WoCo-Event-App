WoCo App — decentralised event platform on Swarm + Ethereum.

PUBLIC FILE — this repo is public. Architecture, conventions and code map only.
No server addresses, SSH targets, deploy commands, or env-secret management here:
that lives in CLAUDE.local.md (untracked, gitignored). Keep it that way.

This file is loaded into EVERY session. Keep it short and high-signal — depth belongs
in `docs/` and gets read on demand. If a section grows past a screen, move it out.

============================================================================
WHERE THE DEPTH LIVES
============================================================================

  docs/DEVLOG.md                  # running history of completed work + roadmap
  docs/NEXT.md                    # current working order
  docs/PAYMENTS_INTEGRATION.md    # Stripe mechanics, crypto rail (off), reservations, ticket card
  docs/PAYOUTS.md                 # AUTHORITY on payouts — manual, released after the event
  docs/PRICING_AND_EMAIL.md       # ALL fee arithmetic (§7, §15–§17). Never restate rates elsewhere.
  docs/EMAIL_NEXT_HANDOVER.md     # email subsystem state + what is next (start here for email work)
  docs/MARKETING_COMPLIANCE.md    # marketing lists, suppression, RFC 8058, abuse gate
  docs/EAS_LIKES_HANDOVER.md      # EAS likes / social graph design + abuse model
  docs/STYLUS_AGGREGATOR.md       # Stylus like-aggregator contract
  docs/MULTI_PAGE_SITE_BUILDER.md # site builder background
  docs/SEO_PLAN.md                # SEO + custom domains
  docs/legal/                     # DATA_INVENTORY, PRIVACY_POLICY, ORGANISER_TERMS, DPA
  docs/CRYPTO_AUDIT_2026-04-08.md + docs/SECURITY_FIXES_2026-04-09.md

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
packages/embed/        # <woco-tickets> (IIFE 113KB) + <woco-lap-count> (41KB, separate bundle)
contracts/             # WoCoEscrow.sol + deploy scripts

============================================================================
FEATURE FLAGS — READ BEFORE ASSUMING A RAIL IS LIVE
============================================================================

`packages/shared/src/features.ts` is the source of truth. Currently OFF:

  cryptoPaymentsAllowed = false   # crypto rail built but unreachable (deferred to #41)
  freeEventsAllowed     = false

Flags gate UI AND server validation in lockstep — an old client cannot reach a disabled
rail past the API. Stripe card payment is the ONLY live payment method.

============================================================================
DEV & DEPLOYMENT
============================================================================

DEV COMMANDS:
  npm run dev:web        # Vite dev server :5173
  npm run dev:server     # opens SSH tunnel to Hetzner bee, then tsx watch :3001
  npm run build:web      # production frontend build
  npm run build:server   # tsc typecheck + build
  npm run build:embed    # BOTH bundles → dist/woco-embed.js, dist/woco-count.js + dist/overlay.html
  npm run build:site     # generated-site build → apps/web/dist-site/
  npm run build:multisite # deployed-site runtime → apps/web/dist-multisite/

- Server deploy goes through `scripts/deploy-server.sh` — it refuses an unclean tree, a
  HEAD that is not `origin/main`, and a linked worktree (which lacks the untracked files
  `--delete` would then remove), dry-runs first and prints the deletion count, and stamps
  the verified commit so `/api/health` reports what is actually running (#125). The
  destination comes from `WOCO_DEPLOY_HOST`/`WOCO_DEPLOY_PATH`, never from this repo.
- All operational detail (dev bee tunnel, deploy procedure, env management, required
  production secrets) lives in CLAUDE.local.md — untracked, this machine only.
- Public shape: backend = Docker Compose stack (bee + bee-proxy + server) on a VM;
  frontend = Swarm feed behind gateway.woco-net.com and woco.eth.limo; API =
  events-api.woco-net.com. Deploys are manual (rsync + compose rebuild).
- IMPORTANT for dev: `npm run dev:server` tunnels to the PRODUCTION bee — anything you
  publish locally lands in the real platform feeds. Be careful.
- Required server env (names only; see `apps/server/.env.example`): EMAIL_HASH_SECRET,
  PAYMENT_QUOTE_SECRET, STRIPE_WEBHOOK_SECRET + STRIPE_WEBHOOK_SECRET_PLATFORM,
  SHOP_SPENDER_SECRET, ZERODEV_RPC, POSTAGE_BATCH_ID, FEED_PRIVATE_KEY, ALLOWED_HOSTS,
  PUBLIC_API_BASE. Optional: SOCIAL_INDEXER_PRIVATE_KEY — signs the indexer's published
  evidence reports (#312), never user data; its address must match `SOCIAL_INDEXER_ADDRESS`
  in `packages/shared`. Unset = reports served on request, never published.

============================================================================
AUTH ARCHITECTURE
============================================================================

Three identity layers:
1. Primary wallet (secp256k1) — permanent identity
2. Session key (secp256k1, random, 30-day expiry) — signs API requests
3. POD identity (ed25519, deterministic) — signs tickets + derives encryption key

Login methods. AUTHORITATIVE LIST = `AuthKind` in `packages/shared/src/auth/types.ts`
(`"web3" | "passkey" | "web3auth" | "coinbase" | "zupass" | "none"`) — read it there.
`zupass` is declared but NOT implemented (needs an ed25519 adapter).

REMOVED — do not reintroduce from old docs: Para embedded wallet and the local browser
account (secp256k1 in IndexedDB) were both deleted in `e127c97` to cut eager bundle size.
`SiteLoginModal.svelte:3` and `backup-signer.ts:173` carry comments explaining why.

Deferred signing: login just connects; EIP-712 `AuthorizeSession` is signed on first
action that needs it (publish, claim, MyTickets). `ensureSession()` is the gate.
`ensurePodIdentity()` runs on publish AND first dashboard decrypt.

Global login popup pattern: `loginRequest.request() → Promise<boolean>` — opens
`LoginModal` from any component. Used by ClaimButton, PublishButton, MyTickets, nav.

CANONICAL REQUEST SIGNING (auth v2, 2026-04-09):

  woco-session-v1\n{METHOD}\n{path}\n{timestamp}\n{nonce}\n{sha256(rawBody)}

Signed EIP-191 by the session key. Server rebuilds the challenge from `c.req.text()`
(raw body bytes — no parse/re-stringify) and `verifyMessage`s it. Timestamp window ±5 min.
All auth material lives in headers:
  X-Session-Address | X-Session-Delegation (b64 JSON) | X-Session-Sig | X-Session-Nonce | X-Session-Timestamp

Session revocation: `POST /api/auth/revoke-session` (single nonce) or `/api/auth/revoke-all`
(all sessions for parent before now). State in `.data/revoked-sessions.json`.

============================================================================
SWARM
============================================================================

- Frontend Bee gateway: https://gateway.woco-net.com (dev) / gateway.ethswarm.org (generated prod sites)
- Backend Bee (in-cluster): http://bee-node:1633 (internal docker DNS, set as BEE_URL on the VM)
- Postage batch: `POSTAGE_BATCH_ID` (server-only)
- Feed private key: `FEED_PRIVATE_KEY` (server-only; platform signer owns all feeds)

PATTERNS:
- Feed data = 4096-byte binary pages (128 slots × 32 bytes); JSON feeds pad with null bytes
- Topic naming: `woco/{domain}/{entity}/{id}`
- Retry with exponential backoff for feed propagation delays

FEED TOPICS:
  woco/event/directory                    # Global event listing
  woco/event/{eventId}                    # Event details + ticket series
  woco/event/creator/{ethAddress}         # Per-organiser event index (never deleted from)
  woco/pod/collection/{ethAddress}        # User's collection
  woco/recovery/{kernelAddress}[...]      # Recovery escrow + status + by-guardian hint (see topics.ts)
  woco/profile/data/{ethAddress}          # User profile
  woco/profile/avatar/{ethAddress}        # Avatar ref (separate feed → independent updates)
  woco/marketing/list/{ethAddress}        # Sealed contact-list pointer
  woco/site/config/{siteId}               # Site JSON (config + theme + pages)
  woco/site/{siteId}/events               # SiteEventsIndex
  woco/site/creator/{ethAddress}[/pN]     # Creator's site directory (paged)
  woco-multisite-{siteId}                 # Per-site feed → latest BZZ content hash (for ENS)
  woco/registry/verified-frontends        # [planned] content hash registry

============================================================================
TICKET / CLAIM FLOW
============================================================================

Payment mechanics: `docs/PAYMENTS_INTEGRATION.md`. Payouts: `docs/PAYOUTS.md`.

TICKETS:
- Series = event ticket type (`totalSupply`, metadata, image)
- Editions = individual tickets, signed by the creator's ed25519 key
- Formats: `woco.ticket.v1` / `woco.ticket.claimed.v1`
- Always-on encryption: every claim encrypts `seriesId + claimerAddress/Email` for the
  organiser dashboard, even without order form fields

CLAIMS:
- Wallet: requires session delegation + per-request canonical sig
- Email:  unauthenticated, rate-limited 3/15min per IP; email stored as HMAC-SHA256
- Passkey / wallet-signed: EIP-191 signed message, no session delegation needed
- Server uses the VERIFIED parentAddress, never an address from the request body
- Double-spend prevention: in-flight lock + per-series async queue serialises writes

APPROVAL FLOW — REMOVED with the v1 claim-rail retirement (#207): routes, flags and
UI are all gone. Do not reintroduce from old docs; #202 tracks its return on the v2
contract rail.

============================================================================
EAS LIKES / SOCIAL GRAPH (#4)
============================================================================

Full design + abuse model: `docs/EAS_LIKES_HANDOVER.md`. Contract: `docs/STYLUS_AGGREGATOR.md`.

A "like" is an EAS attestation on Arb Sepolia — NOT an NFT, NOT a POD. Three tools, three
jobs: NFT = identity/name, EAS = likes/follows/attendance, POD = tickets/gates.

- Attester = the user's own account (user-attested). Parent IS the attester here, unlike
  feeds: web3 = parent EOA signs own-gas; passkey = Kernel attests gasless via scoped
  session key. Both: `attester == parent` — that check is the linchpin.
- Schema `bytes32 subject,uint8 subjectType` (revocable), UID `0x62c5b546…dda64`
  (registered + verified on Arb Sepolia, also `EAS_SCHEMA_UID` env).
- Stylus aggregator (#5, shipped 2026-06-11) on Arb Sepolia
  `0x7dbf8d3a58bebb642fa1a478bbffba4675f1ba20`. ABI + address in `packages/shared` likes/types.ts.
  GOTCHA: Stylus multi-value returns = ONE ABI tuple — fragments need `returns (tuple(...))`.
- Server is a CACHE not truth: `.data/likes-index.json` is a projection, rebuildable from
  chain logs (`reconcileFromChain`).

============================================================================
MULTI-PAGE SITE BUILDER
============================================================================

Builder UI lives at `#/build` inside the main WoCo app. Deployed sites are standalone BZZ
collections on Swarm — no server at runtime. Background: `docs/MULTI_PAGE_SITE_BUILDER.md`.

SCHEMA: `packages/shared/src/site/types.ts` is the single source of truth (Site, ThemeTokens,
Page, Section union, SiteEventsIndex, SiteDirectory[Entry], SiteRuntimeConfig → injected as
`window.SITE_CONFIG` at deploy time). Read it there.

PUBLISH FLOW (two-step):
1. `POST /api/sites` → writes Site + SiteEventsIndex feeds atomically; upserts
   SiteDirectoryEntry into the creator's directory feed
2. `POST /api/sites/:id/deploy` → injects SITE_CONFIG + SEO/PWA meta, tars dist-multisite/,
   uploads BZZ collection, writes content hash to the per-site feed, auto-whitelists hashes
   on the gateway, re-upserts the directory entry. Returns `{ contentHash, feedManifestHash, siteUrl }`

AUTH: all write endpoints require the same EIP-712 session delegation used by events. Owner
is stamped server-side from the verified parentAddress.

MY SITES: `GET /api/sites/mine` reads the creator's Swarm directory. localStorage
`woco:my-sites` is a write-through cache seeded for instant paint; the API is truth.

EVENT LOADING (deployed site): `GET /api/sites/:id/events-full` — bundled, 5-min server cache
+ Cache-Control for CF edge; client 2h stale-while-revalidate. Preview mode skips cache.

SEO: `siteDescription` injected at DEPLOY time (meta description, og:*, twitter:card;
ogImage = logo Swarm ref); MultiSiteApp updates meta description per-page at runtime.

TEMPLATE PRESET: pub-venue-v1 (only one so far). `newSiteFromTemplate()` in shared.

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
  apps/web/src/lib/auth/login-request.svelte.ts      # global login popup trigger
  apps/web/src/lib/auth/signing-request.svelte.ts    # EIP-712 confirm dialog trigger
  apps/web/src/lib/auth/session-delegation.ts        # session key + delegation
  apps/web/src/lib/auth/pod-identity.ts              # ed25519 POD derivation
  apps/web/src/lib/auth/ensure-action.ts             # requireAccountForAction() gate
  apps/web/src/lib/auth/signers/{index,web3-signer,passkey-signer,coinbase-signer,local-signer}.ts
  apps/web/src/lib/auth/{web3auth-account,passkey-account,kernel-account,coinbase-account}.ts
  apps/web/src/lib/api/client.ts                     # authPost/authGet + buildAuthHeaders

AUTH (server):
  apps/server/src/middleware/auth.ts                 # session delegation + canonical sig verify
  apps/server/src/lib/auth/verify-delegation.ts      # EIP-712 verify + sessionProof + revocation
  apps/server/src/lib/auth/revocation.ts             # nonce blacklist + revoke-all

CLAIMS / EVENTS:
  apps/server/src/routes/claims.ts                   # claim endpoint + wallet auth + email rate limit
  apps/server/src/routes/events.ts                   # create / discover / list / unlist
  apps/server/src/routes/tickets.ts                  # email send (composite PNG + /t link)
  apps/server/src/lib/event/claim-service.ts         # core claim + approval logic
  apps/server/src/lib/event/service.ts               # event creation
  apps/server/src/lib/swarm/topics.ts                # feed topic derivation
  packages/shared/src/pod/verify.ts                  # ed25519 ticket signature verification

EAS LIKES:
  apps/web/src/lib/eas/{eas-abi,attest}.ts           # attestLike/revokeLike
  apps/server/src/routes/likes.ts                    # verify-on-chain record + reads
  apps/server/src/lib/likes/eas-onchain.ts           # getVerifiedLike (linchpin) + reconcileFromChain
  apps/server/src/lib/likes/index-store.ts           # .data/likes-index.json projection
  packages/shared/src/likes/types.ts                 # schema, SubjectType, EAS addresses

FRONTEND COMPONENTS:
  apps/web/src/App.svelte                            # shell: top bar + routing + bottom nav
  apps/web/src/lib/components/auth/{LoginModal,SigningConfirmDialog}.svelte
  apps/web/src/lib/attendee/events/{ClaimButton,EventCard,EventDetail}.svelte
  apps/web/src/lib/creator/events/PublishButton.svelte
  apps/web/src/lib/attendee/passport/MyTickets.svelte
  apps/web/src/lib/creator/dashboard/Dashboard.svelte
  apps/web/src/lib/creator/embed/EmbedSetup.svelte
  apps/web/src/lib/components/profile/{ProfilePage,UserAvatar,CreatorChip,WalletTab,ConnectWalletModal}.svelte

SITE BUILDER:
  apps/web/src/MultiSiteApp.svelte                          # deployed site runtime shell
  apps/web/src/lib/creator/builder/MultiSiteBuilder.svelte  # builder UI
  apps/web/src/lib/creator/builder/MySitesScreen.svelte     # "Your websites" landing
  apps/web/src/lib/creator/builder/tabs/{BrandTab,PagesTab,NavTab,EventsTab,TemplateTab}.svelte
  apps/web/src/lib/creator/builder/SectionEditor.svelte
  apps/web/src/lib/components/site/sections/{SectionRenderer,EventsGridSection,FeaturedEventSection}.svelte
  apps/web/src/lib/api/sites.ts                             # publish/deploy/load/getCreatorSites
  apps/server/src/routes/sites.ts                           # /api/sites/*
  apps/server/src/lib/site/service.ts                       # getCreatorSites / upsertCreatorSite
  packages/shared/src/site/{types,templates,topics}.ts
  apps/web/src/lib/cache/cache.ts                           # stale-while-revalidate localStorage cache

WALLET / CONTRACTS:
  apps/web/src/lib/wallet/{provider,wc-provider,connection}.ts
  contracts/src/WoCoEscrow.sol                       # time-locked escrow (ReentrancyGuard, 150bp fee)
  contracts/src/ContentHashRegistry.sol              # World Computer Registry
  contracts/script/{Deploy,DeployRegistry}.s.sol
  contracts/test/{WoCoEscrow,ContentHashRegistry}.t.sol

Payments + marketing file maps live in their own docs (see WHERE THE DEPTH LIVES).

============================================================================
KNOWN GOTCHAS
============================================================================

BUILD / DEPLOY:
- `Vite base` must be `'./'` (relative) — absolute paths break under Swarm `/bzz/` URLs
- Upload script is `.cjs` (monorepo has `"type": "module"`)
- ALLOWED_HOSTS must include every frontend host or session delegation 403s
- Server start script is `npm run start` (`node --import tsx src/index.ts`), NOT `node dist/index.js`
- Hono default 404 returns plain text "404 Not Found" — `authPost`'s `resp.json()` throws
  "Unexpected non-whitespace character at position 4". Consider a global 404 JSON handler
- `build:multisite` → dist-multisite/ (NOT `build:site` → dist-site/). The server reads
  dist-multisite/ at site-publish time and bakes it into the Swarm collection. It is excluded
  from the standard deploy sync — run the multisite deploy step (CLAUDE.local.md) whenever the
  multisite runtime changes, then organisers must re-publish their sites to pick up the bundle
- `GET /api/sites/mine` must be registered BEFORE `/:id` in Hono or "mine" matches as a siteId
- Creator directory upsert is fire-and-forget on both publish and deploy — non-fatal
- `contracts/` is a NESTED git repo (Foundry project, branch `master`) — commit there
  separately from the monorepo; `git status` at the root will not show its changes

SECURITY / AUTH:
- `EMAIL_HASH_SECRET` must be set before deploying — without it, emails are unsalted SHA-256
  hashed (vulnerable to rainbow tables on public Swarm feeds). Rotating it also invalidates
  every outstanding unsubscribe link
- `POD_IDENTITY_DOMAIN` now includes a salt — changes the derived ed25519 key for any user who
  already published an event. Deploy `SESSION_DOMAIN` salt first; only deploy the POD salt
  after confirming no active POD identities, or build a migration path
- Canonical challenge relies on raw body bytes: server MUST use `c.req.text()` BEFORE any
  parse/re-stringify, and the client must hash the exact bytes it sends
- SESSION_DOMAIN has NO chainId — ALLOWED_HOSTS is the host security guard

GATEWAY WHITELIST IS NOW DATA-PLANE STATE, not a cache. The bee-proxy serves only addresses
in its whitelist and tags its refusal (`X-Chunk-Gate: not-whitelisted`); the client treats that
tagged 403 as "this chunk does not exist" — which is what took a cold credit read from 15.2s to
~1.4s (#329). So a LOST whitelist entry makes real data read as absent, and an absent read is
`clean`, which is exactly what the `scanClean`/`bandClean` erasure guards check for. Reads that
feed a read-modify-write pass `thorough` and never trust the gate for this reason. Back up
`whitelist.json`; never deploy an empty one over it.

`.data/broadcast-chunks/` is the OPPOSITE case — it must NOT survive. Broadcast recipients
are encrypted under a key held only in the running process, so a restart makes them
permanently unreadable and the boot sweep deletes them. A deploy therefore kills in-flight
broadcasts; the organiser resumes from the builder. Check for running jobs before deploying:
`curl https://events-api.woco-net.com/api/health | jq .email.broadcasts`

`.data/` FILES THAT MUST SURVIVE RESTARTS (loaded on startup — don't delete):
  consumed-tx-hashes.json · revoked-sessions.json · consumed-stripe-sessions.json
  kernel-deployed.json (which Kernels have been seen with an on-chain owner, WHICH
    owner, and at which L2 block — losing it reopens the #200 windows, silently, on
    the next deploy: the counterfactual fallback returns and a lagging RPC replica
    can roll the owner back to a retired key)
  stripe-accounts.json · stripe-payout-ledger.json · stripe-payout-intents.json
  pending-refunds.json (#367 — auto-refunds Stripe refused to create; losing it = a buyer
    charged with no ticket and no refund, and no alarm; `/api/health` `pendingRefunds`)
  marketing-consent.json (Art. 7(1) evidence for checkout opt-ins)
  event-attendees.json (#387 — eventId → attendee email hashes, appended at fulfilment;
    the ONLY server-visible proof a broadcast recipient holds a ticket. Losing it means no
    organiser can tell attendees their event is cancelled, and it CANNOT be rebuilt: the
    plaintext address is never stored anywhere we could re-derive it from)
  marketing-suppression.json (losing it = emailing unsubscribers, a legal breach)
  marketing-lists.json · marketing-domains.json · marketing-send-log.json
  consumed-resend-events.json
  consumed-sns-events.json (also dedupes the failure-ledger write for an async bounce —
    losing it double-records an undelivered ticket, not just a repeated suppression)
  email-failures.json (the undelivered-ticket ledger — the /api/health alarm reads it)
  broadcast-jobs/*.json (hash-only send accounting — losing it loses the "resume the
    broadcast that died" path AND the /api/health alarm that says one did)
  event-listing-state.json (#37 global-directory overlay) — if lost, the builder self-heals by
  reseeding from the last snapshot (directory-snapshot.ts) rather than publishing an empty
  directory, but that only recovers events already in a snapshot

SVELTE 5 / BEE-JS:
- Svelte 5 `$state` proxy: properties absent from the initial object literal aren't reactive;
  always initialise ALL fields at declaration (e.g. `approvalRequired: false`, not omitted)
- bee-js v11: `writer.upload()` requires `new Reference(hexString)`, not a plain string;
  feed verification uses `feed.feedIndex` (not `feed.reference`, which no longer exists)

RUNTIME:
- Local account sign-out clears session but keeps keypair for re-login
- `MyTickets` triggers `ensureSession` on mount (lazy EIP-712), not just on login
- Embed widget wallet claims disabled — needs session delegation support in the widget
- Web3 auth init: if the wallet isn't immediately available after redirect, session restores
  from IndexedDB and the wallet reconnects in background (10s retry). Prevents logout on
  external redirects (Stripe onboarding, etc.)
