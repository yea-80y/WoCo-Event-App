# Handover — event publish (create step 1→2) is slow (2026-06-29)

Branch `feat/feed-signer-recovery`. Read `CLAUDE.md` + memory
`project_client_feeds_editions_gap`, `woco_builder_is_event_creator`,
`project_etherna_integration`, `project_phase_b_carrier_discovery` FIRST. Terse.

## TL;DR
The editions claim fix (B1) is committed + the SERVER is deployed; it fixes
claim/reserve/Stripe "Series not found". The OPEN PROBLEM is **publish speed**: creating
an event uploads **many small Swarm /bytes chunks one at a time** and is much slower than
pre-Etherna/pre-client-feeds. There are TWO stacked causes (verified against the code):
1. **Server v2 create** uploads each pod body as a separate Etherna `/bytes` write,
   serialised 2-wide and AWAITING `registerEthernaOffer` per chunk → Codex measured
   ~5.8–6.4s for 10 pods. Pre-dates B1 (v2 manifest + Etherna routing, serialised by
   `702e696` to avoid 423 Locked).
2. **B1 editions publisher** ADDS N more per-ticket browser→server uploads on top.
Fix BOTH. Do NOT remove the editions feed to "fix speed" — it is required (see below).

## Tree state (start here)
- Committed + GOOD base:
  - `ee65efe` server reads editions as carrier-owned SOC + `/api/swarm/bytes` rail +
    carrier threaded through claim/reserve/Stripe. **DEPLOYED to prod (server), health green.**
  - `932394e` browser publishes carrier-owned editions (`editions-publisher.ts`,
    `client-bytes.ts`, PublishButton). **Frontend NOT deployed** (owner runs `npm run deploy`).
- UNCOMMITTED (Codex, INTENTIONAL — keep, do NOT revert): threads the server-verified
  updated event feed through `/register-on-chain` so the client signs a SOC that reliably
  carries `onChainEventId`:
  - `apps/server/src/routes/events.ts` — `/:id/register-on-chain` returns
    `eventFeed: updatedFeed` (the `confirmSeriesOnChain` result) when `creatorFeedSigner` set.
  - `apps/web/src/lib/api/events.ts` — `registerSeriesOnChain` returns optional `eventFeed`.
  - `apps/web/src/lib/creator/events/PublishButton.svelte` — re-signs the returned feed;
    editions publish KEPT (removing it caused "Series not found" in claim-status/reservations).
  This is orthogonal to speed and unproven; evaluate + commit on its own merits.
- Local-only (gitignored, harmless): `apps/server/.data/stripe-accounts.json` got a prod
  test mapping for the creator; `apps/web/.env.local` has `VITE_API_URL=prod`.
- `docs/FEED_SIGNER_ESCROW_HANDOVER.md` — pre-existing untracked, ignore.

## ROOT CAUSE (confirmed in code — NOT "falling back to legacy")
Both paths funnel through `apps/server/src/lib/swarm/bytes.ts` → `uploadToBytes`, which
holds `beeUploadSem` (`upload-queue.ts`, **2-wide global**) and, for Etherna, AWAITS
`registerEthernaOffer(reference)` per upload. One postage batch ⇒ concurrent stamps hit
423 Locked, which is why `702e696` serialised them. So every pod body + every editions
ticket body + meta + manifest is a remote round-trip, ~2-wide, offer-awaited.
- `createEventV2` (`service.ts`): N pod bodies (`Promise.all` batched 40, but the
  semaphore re-serialises) + M manifests + image. → the ~6s/10pods Codex measured.
- `editions-publisher.ts`: one `stampBytes` `POST /api/swarm/bytes` PER ticket (+meta),
  `STAMP_CONCURRENCY=8` but bottlenecked by the same server semaphore + per-request RTT
  to prod (`VITE_API_URL`). For an N-ticket series, N+1 extra round-trips.
Net: a publish now does ~2N small serialised remote uploads. Pre-client-feeds, editions
were built server-side in ONE batched pass and pods hit the local WoCo bee.

## FIX PLAN (do in this order)
1. **Stop awaiting `registerEthernaOffer` per chunk** (`bytes.ts`). Make it
   fire-and-forget (server reads are bearer-authed pre-offer; the offer only enables
   anonymous gateway reads, not the server's own claim reads). Biggest cheap win; removes
   a remote RTT from EVERY upload. Verify reads still resolve (downloadFromBytes races
   Etherna bearer + WoCo bee).
2. **Tune upload concurrency vs 423.** The 2-wide cap is a blunt fix for 423 Locked. Test
   whether the Etherna batch tolerates more concurrent stamps (different buckets) — raise
   `beeUploadSem` width and/or add per-batch bucket spreading. Measure 423 rate.
3. **Bulk the editions body upload** so it stops being per-ticket:
   - SERVER: `POST /api/swarm/bytes/batch` (auth-gated, `swarm.ts`). Body
     `{ itemsB64: string[]; gatewayUrl? }`; resolve `batchForDeploy(...)` ONCE; upload all
     via `Promise.all` chunks of ~40; return `{ refs: string[] }` in order. Cap count/size.
   - CLIENT: in `editions-publisher.ts` build ALL `SignedTicket`s locally (ed25519, no
     I/O), send ONE batch call per series, map refs back, then pack4096 + sign page SOCs.
     Add `stampBytesBatch()` to `client-bytes.ts`. Delete the per-ticket loop.
4. **Reduce the upload COUNT entirely (the real win):** the per-edition `woco.ticket.v1`
   bodies are near-identical (only `edition` differs) and EVERY field is derivable from
   the page-0 meta + slot index. Change the CLAIM path to DERIVE `ClaimedTicket` from meta
   + edition number instead of `downloadFromBytes(ticketRef)` (`claim-service.ts`), and
   stop uploading per-edition bodies at all. The editions page then stores meta + a marker.
   This removes ALL N editions uploads — bigger than (3) but the correct end state short of B2.
5. **B2 (north star):** claim straight from the on-chain-anchored `SeriesManifestBlob.podRefs`
   (already uploaded by createEventV2) with Merkle-inclusion proof; retire the editions feed
   AND collapse the duplicate pod/editions uploads. Touches claim/email/card/MyTickets.

Recommend (1)+(2) immediately (helps the server pod path too), then (3) or jump to (4).

## Editions is REQUIRED — do not delete it for speed
`claims.ts` wallet/email/crypto claims ALWAYS use `claimTicket → editions`. Reserve +
claim-status use the contract ONLY when `onChainEventId` is set, else editions. Only the
Stripe CARD path on paid+registered events mints on-chain and skips editions. Free events
have no on-chain path at all. So editions must exist; the fix is to publish it CHEAPLY,
not to remove it (Codex correctly reverted that attempt).

## Local testing recipe (from Codex, verified sane)
- `VITE_API_URL=http://localhost:3001 npm run dev:web` + `npm run dev:server` (dev bee
  tunnel to Hetzner). Without the override, dev:web hits PROD (`apps/web/.env.local`).
- Local server needs a creator Stripe record in `apps/server/.data/stripe-accounts.json`
  (gitignored) to test paid card flows.

## Owner to-do after the speed fix
1. `npm run deploy` the creator-app frontend. 2. **RE-PUBLISH existing events** (B1 writes
editions at publish time — older events still fail to claim). 3. Verify on a NEW event:
reserve, Stripe checkout, email claim.

## Deploy reminders
- Server: STEP 1 (rsync + `docker compose up -d --build server`) — Claude owns it.
- `dist-site` UNTOUCHED by this work (claim read is server-side; editions publish is in
  the creator app). No `dist-site` rsync needed.
