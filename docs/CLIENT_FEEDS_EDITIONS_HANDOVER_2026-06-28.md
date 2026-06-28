# Handover — client-signed event feeds: editions gap + path forward (2026-06-28)

Branch: `feat/feed-signer-recovery` (NOT merged). Read `CLAUDE.md` + memory
`woco_builder_is_event_creator`, `project_phase_b_carrier_discovery` FIRST.
SiteBuilder IS the event creator. Keep docs terse.

## TL;DR
Event LOADING is fixed + live. Event CLAIMING (reserve / Stripe purchase / email) is
broken on client-signed events: **the Swarm editions feed is never written**, so the
claim path throws "Series not found" → Stripe auto-refunds → buyer gets no ticket/email.
Decision: do NOT revert to a server/platform-signed editions feed (option A, rejected by
owner). Move editions to **client-published, carrier-owned** (option B1 below). North
star = claim from the on-chain-anchored manifest, retire the editions feed (B2).

## State of the working tree — IMPORTANT
These changes are **DEPLOYED to prod** (rsync'd to the VM + container rebuilt + fresh
`dist-site` synced) but are **UNCOMMITTED in git**. Commit them first in the next chat
(small commits): 
- `apps/server/src/lib/swarm/bytes.ts` — Etherna upload now retries + uses the
  `beeUploadSem` semaphore (parity w/ WoCo path); 423 classified transient;
  `Swarm-Deferred-Upload: true`. FIXES the "Etherna /bytes upload 423: Locked".
- `apps/server/src/routes/site.ts` — `/api/site/deploy` resolves the event's
  `creatorFeedSigner` via `getCreatorEvents(parentAddress)` and bakes it into
  `SITE_CONFIG.eventSigner`.
- `apps/web/src/lib/components/site/EventPage.svelte` — passes
  `SITE_CONFIG.eventSigner` to `getEvent(eventId, apiUrl, signer)`.
- `packages/shared/src/site/types.ts` — `SiteRuntimeConfig.eventSigner?: string`.
- `apps/web/src/lib/components/site/SiteLoginModal.svelte` — removed dead
  `ParaLogin` import (it had silently broken `build:site` since Para was pulled →
  `dist-site` was frozen at Jun 4; that's why prior EventPage fixes never took effect).

Prod deploy done via: STEP 1 (rsync repo + `docker compose up -d --build server`) AND a
separate `rsync -az --delete apps/web/dist-site/ …/repo/apps/web/dist-site/` (dist-site
is a `:ro` volume mount, excluded from the standard rsync — must sync it explicitly;
no rebuild needed). Health green.

## What WORKS now (verified live)
- Create event w/ Etherna selected → uploads land on the Etherna **platform batch**
  (`ETHERNA_PLATFORM_BATCH`, healthy: usable, ~20d TTL). 423 is retried.
- Deployed event page loads at `{gatewayUrl}/bzz/{contentHash}/` — carrier baked into
  `SITE_CONFIG`, page reads the client-signed detail SOC via `?signer=`.

## ROOT CAUSE of "Series not found" (confirmed from prod logs + git)
- Live claim path: `claims.ts`/`stripe.ts`/`reservations.ts` → `getClaimStatus` →
  `loadSeriesMeta(seriesId)` (`claim-service.ts:380`) → `readFeedPageWithRetry(
  topicEditions(seriesId,0))` → null → throw "Series not found".
- The editions feed `woco/pod/editions/{seriesId}` (page 0 = `pack4096([metaRef,
  ticketRef1…N])`, slot 0 = `{totalSupply,pageCount,approvalRequired}`, slots 1..N =
  `woco.ticket.v1` `SignedTicket`s) is **written NOWHERE** in the current tree (server
  or client). Commit `67b6c60` (v2 ticketing) removed the server-side write; the
  intended client-side replacement ("real organiser publishes signed editions
  client-side" — see `b20fb18` doc + `apps/server/scripts/agent/seed-demo-editions.ts`)
  was never wired into `apps/web`.
- Claim verifies each editions slot with `verifyTicketSignature` (`packages/shared/
  src/pod/verify.ts`) = ed25519 over `JSON.stringify(ticket.data)` vs the ticket's OWN
  embedded `publicKey` (anti-tamper only — NOT tied to the creator's real POD key).
- NOTE the version-axis trap: `woco.ticket.v1` is the POD artifact schema, NOT the
  on-chain contract. We stay on WoCoEventV2 regardless.

## ARCHITECTURE (agreed with owner)
Three layers; server only where it MUST coordinate:
1. On-chain WoCoEventV2 = ledger (supply, holdings, gating, crypto escrow).
2. Client-owned content (client-signed, carrier = organiser feed-signer ADDRESS, public):
   event detail feed (DONE) + editions (the manifest is already client-signed; its
   Merkle root is registered on-chain).
3. Server-coordinated allocation ONLY: claims feed (slot alloc / double-spend) + Stripe.
   This is why reservations stay server-side. Everything else is client-owned.

Claiming WITHOUT the organiser key IS possible: the server needs the carrier ADDRESS
(public, already in detail feed / directory / site index / `SITE_CONFIG.eventSigner`),
never the private key.

## PLAN — B1 (do this next; forward, bounded)
Make the organiser's browser publish the editions feed as a **client-signed SOC owned by
the carrier**; server reads it via the carrier and threads the carrier through the claim
path. No platform signer on editions. Claims feed stays server-coordinated.

1. CLIENT (publish flow, near `event-builder.ts` / PublishButton / SiteBuilder):
   build per-edition `woco.ticket.v1` `SignedTicket`s signed with the creator's POD
   ed25519 key (real authenticity); upload bodies (route to Etherna batch when selected,
   same as detail content); build `pack4096` pages; write `topicEditions(seriesId, p)`
   as client-signed SOC(s) via the existing client-SOC rail (`client-soc.ts` /
   `content-feed.ts` → `/api/swarm/soc`), owner = carrier. Pagination: page 0 = slot 0
   meta + editions 1..127; pages 1+ = 128 each (`editionPageCount`, `PAGE_0_CAPACITY`).
2. SERVER read side: `loadSeriesMeta` must read editions via the **carrier-owned SOC**
   (use `readContentFeedJson`/SOC reader with owner=carrier), NOT the platform
   `readFeedPage`. Thread the carrier into `getClaimStatus`, `claimTicket`,
   reservations (`reservations.ts`), and Stripe (`stripe.ts` create-checkout + webhook).
   The deployed page already holds the carrier (`SITE_CONFIG.eventSigner`) → pass it as
   `?signer=`/body like `getEvent` does.
3. Keep the claims feed (`topicClaims`) server-written/platform-signed (allocation +
   double-spend). Drop any expectation of a platform-written editions feed.
4. Remove the now-dead `pack4096` import in `claim-service.ts` if unused after.

Reject A (server re-seeds platform-signed editions): backward, owner rejected it.

## NORTH STAR — B2 (later, deliberate)
Claim directly from the client-published manifest (`SeriesManifestBlob.podRefs`,
`woco.ticket.v2`), verify a podBody's Merkle inclusion vs the on-chain-registered root,
retire the separate editions feed entirely (no duplicate per-edition uploads). Bigger —
touches claim/email/card/MyTickets (v1→v2 artifact). Do after B1 stabilises.

## SPEED (owner pain point — partially addressed, more to do)
Create step 1→2 is slower than pre-client-feeds because event content now uploads to
remote Etherna (vs local WoCo bee) AND the per-chunk `registerEthernaOffer` is AWAITED.
Cheap win not yet done: make `registerEthernaOffer` fire-and-forget (server reads are
bearer-authed pre-offer). B1 will ADD editions uploads — make sure offers are
fire-and-forget and uploads stay 2-wide concurrent before measuring.

## GOTCHAS / FACTS (don't re-derive)
- `getUserBatch()` (`etherna/batches.ts`) has NO expiry/usability check — a dead user
  batch would route uploads into a wall. No user batch exists today (local + VM `.data`
  empty) so events use the platform batch. Harden when batch renewal lands.
- VITE_API_URL = https://events-api.woco-net.com in ALL `apps/web/.env*` → the dev
  frontend hits PROD. Local server changes need DEPLOY to affect the owner's tests
  (this wasted a cycle).
- `dist-site` = `npm run build:site` (single-event runtime, `SiteApp.svelte` →
  `EventPage.svelte`). `dist-multisite` = the website builder (separate; secondary).
- `/api/site/deploy` (singular) = EVENT deploy; `/api/sites/*` (plural) = website builder.
- Stripe webhook auto-refunds on unrecoverable claim failure — that's why a failed
  claim shows "success" then silently refunds with no email.
