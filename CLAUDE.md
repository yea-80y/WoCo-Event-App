WoCo App — decentralised event platform on Swarm + Ethereum.

PUBLIC FILE — this repo is public. Architecture, conventions and code map only.
No server addresses, SSH targets, deploy commands, or env-secret management here:
that lives in CLAUDE.local.md (untracked, gitignored). Keep it that way.

This file is loaded into EVERY session. Keep it short and high-signal — depth belongs
in `docs/` and gets read on demand. If a section grows past a screen, move it out.

============================================================================
WHERE THE DEPTH LIVES
============================================================================

  README.md                       # public front door (rewritten 2026-09-08)
  docs/README.md                  # INDEX of all docs, sorted by how far to trust each
  docs/ARCHITECTURE.md            # the map: layers, trust boundaries, one ticket traced
  docs/IDENTITY_AND_KEYS.md       # all four keys, the one seed, sealed envelopes, API auth
  docs/SWARM_DATA_MODEL.md        # SOC/CAC addressing, versioned feeds, topics, bands
  docs/TICKETING.md               # issuance -> sale -> mint -> door
  docs/SITE_BUILDER.md            # sites: publish/deploy, feeds, quota
  docs/CONTRIBUTING.md            # setup, tests, CI gates, conventions
  docs/DEVLOG.md                  # running history of completed work + roadmap
  docs/NEXT.md                    # current working order
  docs/PAYMENTS_INTEGRATION.md    # Stripe mechanics, crypto rail (off), reservations, ticket card
  docs/PAYOUTS.md                 # AUTHORITY on payouts — manual, released after the event
  docs/PRICING_AND_EMAIL.md       # ALL fee arithmetic (§7, §15–§17). Never restate rates elsewhere.
  docs/EMAIL_NEXT_HANDOVER.md     # email subsystem state + what is next (start here for email work)
  docs/MARKETING_COMPLIANCE.md    # marketing lists, suppression, RFC 8058, abuse gate
  docs/SWARM_SOCIAL_PLAN.md       # AUTHORITY on likes/follows (Swarm-native, not EAS)
  docs/EAS_LIKES_HANDOVER.md      # SUPERSEDED rail — kept for its abuse model only
  docs/STYLUS_AGGREGATOR.md       # SUPERSEDED — went with EAS
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
packages/shared/       # Shared types, object schema, constants (single source of truth)
packages/embed/        # <woco-tickets> (IIFE 51KB, guest Stripe checkout) + <woco-lap-count> (42KB, separate bundle)
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

- Server deploy goes through `scripts/deploy-server.mjs` — it refuses an unclean tree, a
  HEAD that is not `origin/main`, a linked worktree (which lacks the untracked files
  `--delete` would then remove) and a non-monorepo root, dry-runs first and prints the
  removal count, re-checks cleanliness after the prompt, and stamps the verified commit so
  `/api/health` reports what is actually running (#125). The destination comes from
  `WOCO_DEPLOY_HOST`/`WOCO_DEPLOY_PATH`, never from this repo.
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

FOUR keys per account — items 1, 2, 4 and 5 below; item 3 is the SEED, which is not a key.
(Was five until #518 removed the ed25519 holder key, 2026-09-10;
issuer-curve migration #443, PRs #447–#453, 2026-09-01).
Full map + why each exists: `docs/IDENTITY_AND_KEYS.md`.
1. Primary wallet (secp256k1) — permanent identity
2. Session key (secp256k1, random, 30-day expiry) — signs API requests
3. Identity SEED (32 bytes, keccak256 of ONE deterministic EIP-712 signature under
   "WoCo Account Keys" / `DeriveAccountKeys`) — NOT a key: the HKDF root for 4, 5 and the
   X25519 encryption key. A fresh device therefore needs TWO signatures total: the session
   delegation and this. `ensureIdentitySeed()` returns a
   BOOLEAN (is the seed available), never a public key. The ed25519 HOLDER key it used to
   derive is GONE from every launch path (#518): `creatorObjectKey` and `holderPubKey` are deleted
   end to end, and no auth surface holds an ed25519 key. Two OUT-OF-LAUNCH-SCOPE rails still
   specify the curve in frozen formats (`woco.credit.v1` holderSig, `woco.cert-challenge.v1`)
   and derive it lazily from the seed themselves — `apps/web/src/lib/credits/holder-key.ts`,
   `@noble/ed25519` imported DYNAMICALLY so it stays out of the eager bundle
   (`apps/web/test/no-eager-ed25519.test.ts` fails if that regresses). CONSEQUENCE: the
   platform holds NO holder identity, so `/attendee-keys` serves none and the cert-issuance
   surface reports every attendee un-certifiable until the cert rail migrates to secp256k1.
4. Issuing key (secp256k1, HKDF from the same seed, generation-parameterised —
   `packages/shared/src/crypto/issuing.ts`) — organiser side: signs manifests + certs.
   Identity of record = its 20-byte ADDRESS, bound to the parent by proof-of-possession
   at every create and by the issuer registry (`woco/issuer/{parent}`, parent-signed
   EIP-712 statements; rotation = a gen bump, no new secret at rest)
5. Content-feed signer (secp256k1, HKDF from the SAME seed as 4 — info "woco/feed-signer/v1",
   `packages/shared/src/crypto/feed-signer.ts`) — its address OWNS the user's content SOCs.
   NO signature of its own since 2026-09-10: it used to sign-to-derive under its own domain
   and be stored + escrowed as an independent secret with a "stored copy wins" rule. The seed
   IS that rule now — one AAD-bound slot, one escrow secret, and a rotated credential cannot
   fork the feeds because it cannot change the seed. Never falls back to platform signing.
   Coinbase Smart Wallet stays parked (non-deterministic 1271 ⇒ no reproducible seed).

NAMING (owner decision, extended 2026-09-10): the retired noun is gone from every code
name, file name and wire literal, so a real 0xPARC POD integration would arrive into an
empty namespace. The product noun is **object** (never a bare `object`/`Object`
identifier — always compounded: `ObjectKind`, `objectEntry`, `objectsRouter`), and the
key material is the **identity seed**. Topics are `woco/object/*`, routes `/api/objects`
and `/creator/objects`, storage keys `woco:auth:identity-seed` / `woco:auth:seed-address`.
`packages/shared/test/no-pod-source.test.ts` fails CI on any reintroduction, and on any
bare `object`/`Object` declaration. The ONE thing frozen through it all is the account-keys
EIP-712 message (`ACCOUNT_KEYS_*`), which was renamed separately on 2026-09-10.

Login methods. AUTHORITATIVE LIST = `AuthKind` in `packages/shared/src/auth/types.ts`
(`"web3" | "passkey" | "web3auth" | "coinbase" | "zupass" | "none"`) — read it there.
`zupass` is declared but NOT implemented (needs an ed25519 adapter).

REMOVED — do not reintroduce from old docs: Para embedded wallet and the local browser
account (secp256k1 in IndexedDB) were both deleted in `e127c97` to cut eager bundle size.
`SiteLoginModal.svelte:3` and `backup-signer.ts:173` carry comments explaining why.

Deferred signing: login just connects; the signatures are asked for on the first action
that needs them, through ONE entry point — `auth.ensureAccountSetup({ identity })`, which
plans the outstanding steps (`lib/auth/account-setup-plan.ts`) and, for external wallets
only, explains them first via `AccountSetupSheet`. Never call `ensureSession()` +
`ensureIdentitySeed()` in sequence at a call site and never count the prompts: how many a
person sees depends on the login kind (passkey/web3auth sign the session silently) and on
what is already on the device. `ensureIssuingKey()` (`lib/auth/issuing-key.ts`) wraps the
seed + derivation — FAIL LOUD when no seed, never another signer.

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
- Feed private key: `FEED_PRIVATE_KEY` (server-only). Owns PLATFORM feeds — directory pointer,
  site events index, creator site directory, issuer-log relay, recovery status, marketing pointer,
  shop config, passport collection — PLUS any event/site feed whose client sent no feed signer.
  User content feeds are owned by the user's OWN signer (key 5 above). The site events index
  stays platform-signed BY DESIGN: it carries `creatorFeedSigner` and is consumed on the
  claim/payment path, so it is a server-written TRUST CARRIER (`routes/sites.ts`)

PATTERNS:
- Feed data = 4096-byte binary pages (128 slots × 32 bytes); JSON feeds pad with null bytes
- Topic naming: `woco/{domain}/{entity}/{id}`
- Retry with exponential backoff for feed propagation delays

FEED TOPICS:
  woco/event/directory                    # Global event listing
  woco/event/{eventId}                    # Event details + ticket series
  woco/event/creator/{ethAddress}         # Per-organiser event index (never deleted from)
  woco/object/collection/{ethAddress}     # User's collection
  woco/recovery/{kernelAddress}[...]      # Recovery escrow + status + by-guardian hint (see topics.ts)
  woco/issuer/{parentAddress}             # Issuer-registry statement log (parent-signed)
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
- Editions = individual tickets ("object data") — committed by a Merkle root in a
  manifest the creator's ISSUING key personal-signs; nothing signs per-edition
- Formats: `woco.manifest.v2` + `woco.edition.v1` (tickets/badges) · `woco.cert.v1` +
  `woco.cert-challenge.v1` (awarded certificates). The v1 formats are DELETED and every
  verifier dispatch-refuses them; creates also require the `issuerBinding` PoP, verified
  and pinned server-side (`.data/issuer-bindings.json`)
- Always-on encryption: every claim encrypts `seriesId + claimerAddress/Email` for the
  organiser dashboard, even without order form fields

BUYING — THERE IS NO CLAIM ENDPOINT (corrected 2026-09-08). The v1 rail's per-kind claim
paths (wallet / email / passkey, the 3-per-15min email limit, the in-flight lock + per-series
write queue) went with #207 and are NOT in the tree. `routes/claims.ts` serves only
`GET /:eventId/series/:seriesId/claim-status`. The one live path is:

  reserve (10-min hold, atomic) → Stripe checkout → webhook → fulfilment:
  seal order to the organiser's X25519 key → one EPHEMERAL BURNER keypair per
  ticket → `batchClaimFor` as the sponsor → burner signs its ticket message,
  key DISCARDED → email the ticket

- Ticket trust root = the on-chain `slotOwner`. A ticket verifies when EIP-191 recover of
  `buildTicketCanonicalMessage` equals it. `unverified` (chain unreachable) is a DISTINCT
  verdict from `invalid` — never collapse them
- Which on-chain event to mint against comes from SERVER state (the id validated into the
  Stripe session, else `onchain-events.json`) — NEVER re-read from the event feed at mint
  time (#426: for a Phase B event that feed is the creator's own SOC, so re-signing it after
  checkout re-pointed the mint with the money already taken)
- Inventory is bounded by reservations + the per-network seat cap (`seat-cap.ts`, #223) plus
  the contract's own `nextSlot` — not by a server-side write lock
- Server uses the VERIFIED parentAddress, never an address from the request body
- Email addresses are HMAC-SHA256 (`hashEmail`); `EMAIL_HASH_SECRET` is MANDATORY and the
  legacy unsalted path is deleted. Still used by marketing + bounce suppression
- No free-ticket path exists (no v2 mint path for one) — `freeEventsAllowed = false`
- Full lifecycle: `docs/TICKETING.md`

APPROVAL FLOW — REMOVED with the v1 claim-rail retirement (#207): routes, flags and
UI are all gone. Do not reintroduce from old docs; #202 tracks its return on the v2
contract rail.

============================================================================
SOCIAL GRAPH — SWARM-NATIVE, NOT EAS (#4)
============================================================================

LIKES AND FOLLOWS LEFT THE CHAIN. Live rail = `woco.like.v1` / `woco.follow.v1`,
chain-free Swarm statements written to the USER'S OWN feed (`packages/shared/src/social/`,
`apps/web/src/lib/social/`, `routes/social.ts`). Authority: `docs/SWARM_SOCIAL_PLAN.md`.
Frozen rules every statement type shares: `packages/shared/src/statement/discipline.ts`.

- Author IS the feed owner, so the SOC signature already binds authorship and the version
  sequence already orders — hence NO holder, NO holderSig, NO seq on these payloads
- Retraction is `value: false`, never a deletion (a SOC cannot be deleted, and absent is
  indistinguishable from never-existed)
- Like/follow STATEMENT feeds are PINNED to band 0 (latest-wins ⇒ no growth axis) — NEVER
  band-walk those. Their SUBJECT INDEX genuinely is banded and IS discovered by walking openers
  (one version per new subject, never removed). Do not conflate the two
- Subjects are keyed by ACCOUNT ADDRESS (owner decision 2026-09-03), not a name namehash —
  a namehash keyed an audience to something governance/custody could move
- Counting is an INDEXER's job, not the platform's; it can publish evidence reports
  (`statement/evidence-report.ts`, #312)

SUPERSEDED EAS RAIL (below) — `packages/shared/src/likes/` + `apps/web/src/lib/eas/` are its
remains, kept for the abuse model. ProfilePage's Following/Trending still read it (#475) and
referral badges still sit on it (#476). Do NOT build new social on it.

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

TEMPLATE PRESETS: pub-venue-v1 · nightlife-v1 · clean-modern-v1 (`TemplateId` in
site/types.ts is the list). `newSiteFromTemplate()` in shared.

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
  apps/web/src/lib/auth/identity-seed.ts             # identity-seed derivation + AAD-bound storage
  apps/web/src/lib/credits/holder-key.ts             # ed25519 holder key — credits/cert rails ONLY, dynamic import
  apps/web/src/lib/auth/issuing-key.ts               # ensureIssuingKey() — fail-loud wrapper
  apps/web/src/lib/auth/ensure-action.ts             # requireAccountForAction() gate
  apps/web/src/lib/auth/signers/{index,web3-signer,passkey-signer,coinbase-signer,local-signer}.ts
  apps/web/src/lib/auth/{web3auth-account,passkey-account,kernel-account,coinbase-account}.ts
  apps/web/src/lib/api/client.ts                     # authPost/authGet + buildAuthHeaders

AUTH (server):
  apps/server/src/middleware/auth.ts                 # session delegation + canonical sig verify
  apps/server/src/lib/auth/verify-delegation.ts      # EIP-712 verify + sessionProof + revocation
  apps/server/src/lib/auth/revocation.ts             # nonce blacklist + revoke-all

CLAIMS / EVENTS:
  apps/server/src/routes/claims.ts                   # claim-status ONLY (v1 claim rail deleted, #207)
  apps/server/src/routes/events.ts                   # create / discover / list / unlist
  apps/server/src/routes/tickets.ts                  # email send (composite PNG + /t link)
  apps/server/src/lib/event/claim-service.ts         # email HMAC + passport collection feed (NOT claims)
  apps/server/src/lib/event/service.ts               # event creation
  apps/server/src/lib/swarm/topics.ts                # feed topic derivation
  packages/shared/src/edition/                       # woco.manifest.v2 + woco.edition.v1 (sign/verify)
  packages/shared/src/cert/                          # woco.cert.v1 rail (sign/verify/log/door)
  packages/shared/src/crypto/issuing.ts              # issuing-key derivation + personal-sign wrapper
  packages/shared/src/issuer/types.ts                # issuer-registry statements + log verify
  apps/server/src/lib/issuer/{binding,registry}.ts   # PoP pin + rotation relay

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
- `EMAIL_HASH_SECRET`: the server REFUSES TO BOOT without it (`index.ts`, no dev fallback
  since 2026-04-09) and the legacy unsalted-SHA-256 path is deleted — so the old "falls back
  to unsalted" warning no longer applies. Rotating it still invalidates every outstanding
  unsubscribe link AND orphans every existing email hash
- 🔴 `ACCOUNT_KEYS_DOMAIN` / `ACCOUNT_KEYS_TYPES` / `ACCOUNT_KEYS_PURPOSE` / `ACCOUNT_KEYS_NONCE`
  (`packages/shared/src/auth/`) are FROZEN FROM LAUNCH — the exact bytes of the one signature
  that establishes an account. Change ANY of them (including the purpose string, which reads
  like UI copy and is not) and every account derives a different seed: sealed orders stop
  decrypting, issuer identities move, and every content SOC is orphaned under an address
  nothing looks at. `apps/web/test/identity-vectors.test.ts` fails on a one-byte change.
  They were renamed off their retired predecessors on 2026-09-10 — a deliberate
  pre-launch break, salt deliberately unchanged
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
  onchain-events.json (#424 — eventId+seriesId → the on-chain event THIS server
    registered. The checkout refuses to charge for a series with no record, and
    `byEventSeries` CANNOT be rebuilt from chain: the walk fills `byManifestRef`
    only, and a registered series never re-enters the tier-3 fill. Losing it
    stops ALL sales until restored. It was a pure cache before #424 — it is not
    one now)
  kernel-deployed.json (which Kernels have been seen with an on-chain owner, WHICH
    owner, at which L2 block, and — since #489 — on which CHAIN: records are keyed
    `{chainId}:{address}` and a record from another chain is ignored, never deleted.
    Losing it reopens the #200 windows, silently, on the next deploy: the
    counterfactual fallback returns and a lagging RPC replica can roll the owner
    back to a retired key)
  stripe-accounts.json · stripe-payout-ledger.json · stripe-payout-intents.json
  pending-refunds.json (#367 — auto-refunds Stripe refused to create; losing it = a buyer
    charged with no ticket and no refund, and no alarm; `/api/health` `pendingRefunds`)
  marketing-consent.json (Art. 7(1) evidence for checkout opt-ins)
  profile-names.json (#464 — which sub-ENS name is an account's PROFILE name, and
    its rename clock. The role is unknowable from chain: a registry says who HOLDS
    a name, never what it is FOR, and the profile feed is client-signed. Losing it
    FAILS OPEN by design — cooldowns reset and the profile-name refusal at the
    binding points stops firing until each user re-binds; nothing is lost that a
    user cannot redo. Note the clock deliberately OUTLIVES the name it refers to:
    nothing deletes a record, or `release old -> mint new -> bind` would read as
    a first bind and skip the cooldown)
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
- Embed widget is card-only (#141 decision): guest Stripe checkout, no wallet/passkey/account.
  Bump the `?v=` cache-buster (EmbedSetup + the frame page) whenever its behaviour changes
- Web3 auth init: if the wallet isn't immediately available after redirect, session restores
  from IndexedDB and the wallet reconnects in background (10s retry). Prevents logout on
  external redirects (Stripe onboarding, etc.)
