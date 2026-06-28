# Handover — client feeds + Etherna routing (2026-06-27)

Branch: `feat/feed-signer-recovery` (4 commits, all typecheck-green; server DEPLOYED).
Read `CLAUDE.md` + memory `woco_builder_is_event_creator` FIRST. The site builder IS
the event creator — one surface, never "two paths".

## DONE this session (committed)

1. `f8a1a18` **feed-signer escrowed like the POD seed** (passkey/web3auth/local).
   Was derived-but-never-escrowed → guardian recovery orphaned feeds. Now: stored
   locally (`feed-signer-store.ts`, AES-GCM AAD-bound), carried in the guardian
   escrow bundle (+ determinism self-check) and the portability envelope, restored
   verbatim on recovery. NO new crypto, NO new SOC, NO random key (independent-of-POD
   via its own derivation domain is enough). Files: `auth-store.svelte.ts`,
   `feed-signer-store.ts`, `storage/encryption.ts`, `swarm/content-feed.ts`,
   `shared/auth/constants.ts`.
2. `e2f2f15` **event content routed to the selected gateway's batch.** `uploadToBytes(data,
   selection?)` is target-aware (Etherna = raw-fetch /bytes + offer; else WoCo bee).
   `createEventV2` computes `batchForDeploy({deployType:"event"})` once, threads it in.
   `gatewayUrl` flows: SiteBuilder → PublishButton → createEventStreaming → /api/events →
   CreateEventV2Request. Directory stays WoCo. (Also carried last session's Fix A/B.)
3. `663add7` **read event content from WoCo OR Etherna (race).** Regression fix: writes
   went to Etherna but `downloadFromBytes` only read the WoCo bee → register-on-chain
   500 "Failed to fetch manifest". Now `Promise.any([woco, etherna])`, WoCo bounded by
   the 60s timeout.
4. `76df189` **TicketSuccess image fallback** (WoCo→Etherna). EventDetail already had it.

## USER MUST DO
- `npm run deploy` (frontend → Swarm). Server already deployed + healthy. Routing only
  works end-to-end once the frontend (which sends `gatewayUrl`) is live.
- Re-test: create event w/ Etherna selected → logs show `[batch-router] event deploy →
  etherna … batch`; register-on-chain should pass.

## ✅ BLOCKER (mostly FIXED 2026-06-28) — skipAutoList client-signed events 404

STATUS: server side FIXED + VERIFIED LIVE (`GET /:id?signer=<carrier>` = 0.37s,
ok:true; was 29s+timeout). Commits `13691af`,`18577ed`. Remaining: (a) USER runs
`npm run deploy` so `SiteBuilder.createWocoListing` sends the carrier; then re-list
(or re-create) the event → page loads. (b) OPTIONAL fast deployed-site event page:
the multisite runtime reads `GET /api/events/:id` with NO `?signer=`, so it resolves
via the SLOW global directory (~29s first load, cached after — the directory-scaling
issue). To make it fast, have the deployed-site event-detail pass the carrier it
already holds from the SiteEventsIndex (`?signer=`) — multisite runtime change →
STEP 1b + re-publish. NOT done.

Original diagnosis (kept for context):

## ⛔ skipAutoList client-signed events 404 — root cause

Symptom: passkey login → create event via builder → event PAGE 404s
(`GET /api/events/:id`, no `?signer=`) AND `/list` returns "Source server returned
HTTP 404". Same root cause. Reproduced on event `5ddc4c0a-…` (creator
`0x90ccc0ba…`).

CONFIRMED FROM DATA (in-container, not inference):
- CLIENT-SIGNED: `getCreatorEvents(0x90ccc0ba…)` → entry `5ddc4c0a` has
  `creatorFeedSigner = 0x3db6c160cbe120fd202c066e32c22978f94ac2b8`.
- SOC UPLOADED + READABLE: `readEventFeedSoc("5ddc4c0a…","0x3db6c160…")` returns the
  full feed ("Etherna test 2"). So the event is RECOVERABLE — NOT lost; do NOT
  re-create. The reproduce-it command:
  `docker compose exec -T server node --import tsx -e 'import("/app/apps/server/src/lib/event/service.ts").then(m=>m.readEventFeedSoc("<id>","<signer>")).then(f=>console.log(!!f, f?.title))'`
- NOT in the global directory (skipAutoList). No-hint `getEvent(id)` misses; a read
  WITH `?signer=0x3db6c160…` works but is SLOW (getEventForDisplay runs the slow
  `getEvent` platform-fallback retries BEFORE the SOC read → ~20s; curl timed out at
  25s — that's a timeout, not SOC-absent). Consider trying the SOC before the slow
  platform fallback in getEventForDisplay.

Root cause (file:line): builder creates `skipAutoList` →
`addToEventDirectory(...,{skipPublicDirectory:true})` (`service.ts:231,630`) writes
the CREATOR directory (carrier present) but SKIPS the global directory.
`getEvent(id)` (no hint) resolves the carrier ONLY via the global directory
(`resolveCreatorFeedSigner`→`listEvents()`, `service.ts:357`) → null → falls back to
the legacy PLATFORM feed (`service.ts:387`) → EMPTY (client-signed) → 404. `/list`
calls `getEvent` to verify → same 404.

IMPORTANT nuance: `stampEventSigners` (`routes/sites.ts:99`) ALREADY resolves the
OWNER's carriers from `getCreatorEvents` (the creator directory, which HAS the
carrier). So the deployed site's events-full / SiteEventsIndex DOES carry the signer
for owner events. The gaps are CALLER-SIDE — two reads that don't pass the carrier
they could:
  1. Deployed-site event-DETAIL read calls `GET /api/events/:id` WITHOUT `?signer=`
     — must pass the carrier it already has from the SiteEventsIndex (multisite
     runtime — `MultiSiteApp`/site EventDetail; needs STEP 1b rebuild + re-publish).
  2. `/list` calls `getEvent(id)` with no signer — `SiteBuilder.createWocoListing`
     must send the creator's `creatorFeedSigner`; `/list` reads via
     `getEventForDisplay(id, signer)` (NEVER cached `getEvent`), verifies
     `creatorAddress==parent`, then stamps the carrier into the global directory
     (`addEventToDirectory` — `EventDirectoryEntry` already has `creatorFeedSigner`).
NO global registry (deliberately reverted) — only thread the carrier the caller
already holds. NOT the Etherna work; a Fix A carrier-threading gap left "NOT done".
The SOC + carrier already exist (proven above), so the fix makes existing events
work — no data migration, no re-create.

NOTE: no-hint `getEvent` reads are SLOW for these events (retry backoff) — budget for
it when diagnosing; prefer reading WITH `?signer=<creatorFeedSigner>` to verify the
SOC exists.

## OPEN follow-ups (pick up here)
1. **Event detail-feed SOC → Etherna.** Still stamps on WoCo via `/api/swarm/soc`
   (`soc-upload.ts` hard-codes `getBee`). Routing it needs the READ path too
   (`apps/web/src/lib/swarm/client-soc.ts` `bee()` is pinned to gateway.woco-net.com)
   + the Etherna SOC upload shape (`writeEthernaFeedUpdate` in `lib/etherna/upload.ts`
   is the reference). Lower priority (1 small chunk).
2. **Coinbase/web3 client-side feed signer** (the deferred phase). External wallets hold
   no raw key → derive the feed signer from a deterministic EIP-712 signature (exactly
   as POD does for web3 today), then same escrow plumbing as passkey/web3auth/local.
   No random key, no SOC. Today web3/coinbase return null from `getContentFeedSigner`
   → platform-signed fallback.
3. **Latency (optional):** `soc-upload.ts:192` still `await`s `whitelistHashes` — make
   fire-and-forget (server-read fallback covers it).
4. `service.ts:137` image whitelist is a WoCo no-op for Etherna images (harmless;
   registerEthernaOffer already makes them readable). Skip-when-etherna if tidying.

## KEY FACTS (don't re-derive)
- `batchForDeploy({ownerAddress, gatewayUrl, deployType})` in `lib/etherna/batch-router.ts`:
  WoCo gw → WoCo batch; Etherna+user batch → user batch; Etherna+no batch+event →
  `ETHERNA_PLATFORM_BATCH` (events NEVER purchase); Etherna+no batch+website → throw.
- Server env has ETHERNA_ENABLED=true, ETHERNA_API_KEY, ETHERNA_PLATFORM_BATCH set.
- Etherna writes = raw fetch + bearer (bee-js@11 onRequest drops headers). Reads via
  /bytes/{ref} work bearer-authed even pre-offer.
