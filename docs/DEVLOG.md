# WoCo App — Devlog

Running history of completed work and roadmap. Stable architecture and conventions live in `CLAUDE.md`.

---

## Build status (as of 2026-04-09)

### Core platform — complete
- Monorepo scaffolding with npm workspaces
- Auth overhaul: web3 wallet + local browser account + Para embedded wallet
- "Build first, sign later" UX (deferred signing at publish/claim time)
- Forget identity (sign out clears session, local key persists for re-login)
- IndexedDB encrypted storage (AES-256-GCM)
- Event creation: form, image upload, ticket signing, Swarm feeds
- Event listing + detail views with hash-based routing
- Multi-page edition feeds (no ticket quantity limit)
- Ticket claiming: wallet (authenticated) + email (rate-limited)
- Always-on encryption for claim data (ECIES: X25519 + AES-256-GCM)
- Organizer dashboard: encrypted order decryption, CSV export
- Webhook relay: manual send to email services
- My Tickets / Passport page (with lazy session delegation)
- Embed widget: email + wallet + passkey claims working, setup configurator
- Server serves embed JS at /embed/woco-embed.js (~71KB, versioned with ?v=N)
- Home page: hero, how-it-works, features, coming soon, footer
- Bottom navigation bar (mobile/PWA-ready)
- Production deployment (Swarm feed + Cloudflare tunnel + woco.eth.limo via ENS)
- Technical architecture docs: `docs/TECHNICAL_ARCHITECTURE.md`
- Architecture visual: `docs/WoCo-Events-Architecture-2026-02-28.pdf`
- Embed widget: wallet + passkey claims (EIP-191 signed, no session delegation needed)
- Embed widget: iframe approach for cross-domain passkey identity (ENS subdomains)
- Double-spend prevention for ticket claims (server-side slot locking)
- Organiser approval flow: approvalRequired per series, pending-claims feed,
  approve/reject endpoints, ClaimButton shows "Request to attend" / "Pending Approval",
  embed widget shows pending state, Dashboard approvals tab
- Client-side stale-while-revalidate caching
- Para embedded wallet: email → Para hosted iframe → EVM wallet
  - `@getpara/web-sdk` + `@getpara/ethers-v6-integration`
  - Signs EIP-712 for session delegation AND POD identity derivation
  - Dashboard decryption works (POD seed stored after first Para sign)

### Next stage — Devcon / EF pitch
- [x] Self-hosted backend packaging — Dockerfile, docker-compose.yml, `.env.example`, `docs/self-hosted-setup.md`
- [x] Site builder MVP — see `apps/web/src/SiteApp.svelte`, `vite.site.config.ts`, `scripts/upload-site-to-swarm.cjs`
- [ ] Payment redirect flow — `paymentRedirectUrl` field exists on `SeriesSummary`; real impl via webhook pending
- [x] Discover + list/unlist events from external server (2026-02-26, updated 2026-02-27)
- [x] Waku discovery — DESIGNED, STRIPPED (see "Real-time discovery" below)
- [x] Crypto payments — ETH + USDC on Base/Optimism/Mainnet/Sepolia (mobile-stable 2026-03-31)
  - NOT YET: WoCoEscrow deployed to mainnet/Base; x402 middleware mounted; organiser trust scoring
- [x] Cryptographic security audit + hardening (2026-04-09) — see `docs/CRYPTO_AUDIT_2026-04-08.md` + `docs/SECURITY_FIXES_2026-04-09.md`
- [ ] Content hash registry (`woco/registry/verified-frontends` feed + WoCo signature)
- [ ] Payment webhook endpoint (receive confirmation → mint ticket; mock-friendly)
- [ ] Zupass login (4th auth method — ed25519 adapter for session delegation)
- [x] User profiles — avatar, display name, bio, website, Twitter/X, Farcaster
- [ ] PWA manifest + service worker

---

## Next stage architecture: Devcon / EF pitch

**Goal**: Build toward a pitch to the Ethereum Foundation to use WoCo infrastructure for Devcon ticket sales. Starting target: side events and affiliated orgs (usable nearly now). Longer term: Devcon main event.

**Scale context**: Devcon sells ~15,000 tickets in phased rounds over weeks — not a throughput problem, a reliability problem. A well-hosted Bee node + robust server handles this comfortably. Swarm reads are distributed and gateway-cached. Side events are the strongest near-term use case.

### 1. Organiser-hosted backend
- EF (or any organiser) clones/downloads WoCo's `apps/server` package
- They deploy on their own hardware with their own Bee node, `FEED_PRIVATE_KEY`, `POSTAGE_BATCH_ID`, `ALLOWED_HOSTS`
- Zero reliance on WoCo servers after setup
- Organiser returns an API URL; WoCo frontend connects to it
- Packaging: Docker Compose + setup guide + env template (done)

### 2. Static frontend site builder (`packages/site-builder`)
- WoCo app feature: form-based builder for organiser's event frontend
- Inputs: event name, dates, location, ticket series, paymentRedirectUrl, gateway URL (recommend `gateway.ethswarm.org`), claim modes, organiser's API server URL
- Output: self-contained static site (Vite build), uploaded to Swarm
- Returns content hash → organiser sets on their ENS (event.devcon.eth) or optionally a WoCo sub-ENS (devcon8.woco.eth)
- Generated frontend includes `Dashboard.svelte` for attendee management — reuse existing component, just needs API URL pointed at organiser's own server

### 3. Devcon team attendee dashboard
- Generated site-builder frontend includes a `/dashboard` route
- Reuse `Dashboard.svelte` + approvals tab entirely — zero new dashboard code
- Organiser logs in with Para (no MetaMask needed for EF team members)
- Dashboard decrypts order data locally using their POD seed

### 4. Content hash registry (community initiative)
- Any Swarm-hosted frontend serving WoCo event pages can register its content hash
- Framed as an open community standard, not WoCo-proprietary
- Entry: `{ hash, eventId, organiserAddress, verifiedAt, signature }`
- Certificate-transparency-style: wallets, browsers, or a smart contract wrapper can verify a frontend is genuine before any ticket interaction
- Feed: `woco/registry/verified-frontends` (initial); long-term: on-chain registry, ENS text record, or ERC/ENS community standard

### 5. Payment webhook
- Devcon has their own payment infrastructure
- Architecture: user completes form → redirect to organiser's payment URL → payment processor sends webhook to WoCo backend → ticket minted on Swarm
- Mock-friendly: can be triggered manually for testing without real payment

### 6. Swarm gateway for production sites
- Site builder should let organisers configure which gateway to use
- Recommend `gateway.ethswarm.org` for production
- `gateway.woco-net.com` runs on a home laptop — not suitable for Devcon scale

---

## Real-time discovery (transport slot — dormant)

**Status**: Waku SDK stripped out (2026-03-22). Architecture was sound but not production-ready: browsers can't connect over ws:// from HTTPS pages (need wss), and single nwaku node = no real P2P. Revisit when Waku matures or implement via WebSocket/SSE on the Hono server instead.

**What's kept** (for future re-integration):
- `packages/shared/src/waku/constants.ts` — content topics, categories, helpers
- `packages/shared/src/waku/event-announce.ts` — `EventAnnouncement` interface (proto IDs in comments)
- `packages/shared/src/waku/index-announce.ts` — `IndexAnnouncement` interface (proto IDs in comments)
- `apps/web/src/lib/waku/discovery.svelte.ts` — transport slot: `mergeWithLive`, `startEventStream` (no-ops)
- `docs/WAKU_DISCOVERY.md` — full architecture reference

**How to re-add real-time**:
1. Implement `startEventStream()` in `discovery.svelte.ts`
2. Connect to transport (WebSocket, SSE, or Waku)
3. Call `processAnnouncement()` to populate `liveEvents` map
4. `mergeWithLive()` in `Home.svelte` and `EventList.svelte` automatically merges them

**Design principles** (still valid):
- Swarm = permanent storage + persistent index (the directory feed IS the catalog)
- Real-time transport = ephemeral signals only (don't duplicate the index)
- Multiple independent indexes (any node can maintain its own)

**Event categories** (defined in `constants.ts`): conference, meetup, hackathon, music, art, workshop, social, sports, other.
