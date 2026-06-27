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
