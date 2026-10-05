# Etherna Gateway Integration

> **Reconstructed 2026-06-21** (the original `ETHERNA_INTEGRATION.md` was deleted).
> Rebuilt from private notes + the code of the time. The companion
> `ETHERNA_COMMIT4_HANDOVER_2026-05-18.md` is not in the public repo.

**Verified against `main` (94364b56) on 2026-10-05.** The routing section below was rewritten to
match the code; the gotchas, SOC protocol and batch notes are kept as recorded, with stale
parts marked.

Etherna is a Swarm gateway: what it stamps reaches the public network like any other Bee upload
(measured 2026-07-14, [ETHERNA_USER_CONTENT_HANDOVER.md](./ETHERNA_USER_CONTENT_HANDOVER.md)).
"On Etherna" means "stamped with an Etherna batch", never "off Swarm".

## Purpose (as recorded 2026-06)

Migrate WoCo off its self-hosted Bee + bee-proxy toward Etherna's hosted gateway
(`gateway.etherna.io`, a Bee fork called **Beehive**). End state = everything on
Etherna; we retire our own Bee node. **Do not propose alternatives** (the owner has
explicitly rejected `gateway.ethswarm.org` and keeping our Bee for end-user reads).

Today (2026-10) the move is per family and partial; platform feeds and the frontend still live
on our own Bee.

## Current routing (2026-10-05)

**One table, shared by client and server:** `FEED_FAMILY_STORES` in
`packages/shared/src/swarm/feed-routes.ts` (#657). Client and server deploy separately, so two
tables would split a family between stores for the gap between deploys - and a feed read from
one store and written to another resolves its previous version as current (#651). The server
reports the table it runs at `/api/health` `feedRoutes`.

| Store | Families |
|---|---|
| **Etherna** (read from our Bee AND Etherna, so a move never strands old versions) | `profile`, `event` and `site` (discovery rows: new ones on Etherna, old ones on WoCo, recorded inside the feed), `manifest`, `social`, `referral`, `recoveryPortability`, `recoveryEnvelope`, `guardianIndex` |
| **WoCo** (our Bee only) | `campaignIssuer`, `credits` (moves last), `cert`, `evidence` |

Outside the table:

| Path | Where |
|---|---|
| Sites, event pages and new events (#617) | Etherna. The builder always targets the Etherna gateway; the picker is gone (#618). |
| A site's platform-written feeds (pointer, legacy config, events index) | Where the site lives - Etherna (#48) |
| Platform feeds (event directory + snapshot, creator site directory, issuer relay, ...) | Our Bee, `POSTAGE_BATCH_ID`, signed by `FEED_PRIVATE_KEY` |
| The frontend itself | Our Bee |

**Which Etherna batch** (`lib/etherna/batch-router.ts`): the owner's own live batch, else the
shared `ETHERNA_PLATFORM_BATCH`. A website on the platform batch is free hosting and needs a
Stripe-verified organiser; every website write also needs that or the owner's own batch. A dead
platform batch refuses the write (503, #610) instead of stamping into a void; a merely low one
is an alarm (`/api/health` `postage`). An expired user batch counts as no batch.

`getBee()` is our own node. Etherna is reached through `lib/etherna/*` and the Swarm read/write
helpers (`lib/swarm/soc-read.ts`, `soc-upload.ts`, `bytes.ts`, `feeds.ts`). A server scan of an
Etherna family that cannot reach Etherna answers `unavailable`, never absent (#657).
`/api/health` `ethernaReads` is red when Etherna families exist but `ETHERNA_ENABLED` /
`ETHERNA_API_KEY` are unset.

**Etherna sends no CORS headers.** Browsers read Etherna-stamped data through the WoCo gateway
(e.g. the organiser's order key, `packages/shared/src/event/order-key.ts`).

## Two read/write gotchas on Etherna (Beehive)

1. **Legacy SOC resolution** — Beehive had removed the legacy-SOC-resolve path
   (a SOC whose payload is a 32-byte *reference* to another chunk wouldn't resolve
   via `/bzz/{feedManifest}/...`; an **inline** SOC whose payload *is* the data
   works). **Mirko reported this FIXED ~2026-06-21** ("aligned our code with bee
   behavior") — re-verify with `apps/server/scripts/etherna-soc-legacy-probe.ts`
   before relying. WoCo rule regardless: **write inline SOC payloads**
   (`uploadPayload`, not `uploadReference`). Main-app JSON feeds already do this
   (`feeds.ts`).
2. **Anonymous reads** — `/bytes/{ref}` works **after an offer is registered**
   (`registerEthernaOffer`); `/bzz/{manifestRef}/` works only if the whole
   downstream chain is valid manifests; **`/feeds/{owner}/{topic}` ALWAYS 401s**
   (no anonymous path, offers don't cover it). So anything that must be read
   anonymously on Etherna should be resolved by **computed SOC chunk address**, not
   the feed endpoint. (This is separate from gotcha #1 and was NOT part of Mirko's
   fix.)

Plus a library trap: **bee-js@11 `BeeOptions.onRequest` shallow-copies headers**, so
auth-header mutations are silently dropped. `lib/etherna/upload.ts` works around this
by bypassing bee-js for HTTP (raw `fetch`) while still using `PrivateKey.sign()` for
the SOC signature.

## SOC write protocol on Etherna (reference: `lib/etherna/upload.ts`)

Already implemented server-side and the canonical reference for any client-signed
SOC work:
```
socId      = keccak256( topic(32) || uint64_BE(index)(8) )
signData   = concat( socId(32), contentRef(32) )      // contentRef = BMT addr of the root CAC
signature  = PrivateKey.sign(signData)                // EIP-191 personal_sign internally
POST /soc/{ownerHex}/{socIdHex}?sig={sigHex}          // body = raw root chunk bytes (span(8)+data)
     headers: Swarm-Postage-Batch-Id, Authorization: Bearer
then registerEthernaOffer(contentRef)                 // so /bytes/{ref} is anonymously readable
```
For a non-feed fixed-identifier SOC, `socId` is just the chosen identifier.

## Batch model (`project_etherna_batch_registry`)

- Sell 1-year hosting up front, **buy postage 1 month at a time** (review utilisation
  before committing 12×). Only paying users get their own batch; free event/site
  testing reuses a **shared platform batch**.
- Store: `apps/server/.data/etherna-batches.json`, keyed
  `ethAddress → { batchId, depth, ttlDays, purchasedAt, expiresAt, paidUntil, gateway }`
  (same file-backed pattern as `stripe-accounts.json` — survives restart, no DB).
- Renewal: top up at `expiresAt - 7d` against `paidUntil`; stop renewing once
  `paidUntil < now` (let TTL lapse). Credit unit is **xDai**, not BZZ.
- (2026-06 record, not current) The provisioned depth-20 platform batch (`fc957ecd…956bb9a`,
  ~688 MB, from 2026-04-30, ~45-day TTL) was the shared one. The live platform batch is
  whatever `ETHERNA_PLATFORM_BATCH` names; its health is `/api/health` `postage`. Check/buy via
  `etherna-batch-check.ts` / `etherna-buy-platform-batch.ts`.
- Per-user purchase (`POST /api/etherna/purchase-batch`) is opt-in: it refuses unless
  `BATCH_PER_USER_AUTO_PROVISION=true`, which stays off while free hosting covers sites and
  event pages.

## Key files & scripts

- `apps/server/src/config/swarm.ts` — own-Bee client, platform signer/owner, batch.
- `apps/server/src/lib/etherna/upload.ts` — Etherna Bee, collection upload, offer
  register, raw-HTTP feed/SOC write.
- `apps/server/src/lib/etherna/auth.ts` — Etherna OAuth bearer token.
- `apps/server/scripts/etherna-*.ts` — batch check/buy, chainstate, feed/SOC probes.

## Env vars

`ETHERNA_ENABLED`, `ETHERNA_GATEWAY_URL` (default `https://gateway.etherna.io`; since #657 only
where the server's own requests go - routing always uses the canonical host),
`ETHERNA_API_KEY` (→ bearer token), `ETHERNA_PLATFORM_BATCH`, `ETHERNA_USER_BATCH_*`,
`ETHERNA_PURCHASE_MAX_BZZ`, `BATCH_PER_USER_AUTO_PROVISION`, `FREE_HOSTING` (default on),
plus the own-Bee set (`BEE_URL`, `PROXY_URL`, `POSTAGE_BATCH_ID`, `FEED_PRIVATE_KEY`).

## Relevance to client-side feed signer / recovery

See `CLIENT_FEED_SIGNER_HANDOVER.md` → "Etherna compatibility". ~~The recovery
portability envelope stays on our own Bee for Phase A~~ - superseded: the recovery families
(portability envelope, escrow envelope, guardian index) moved to Etherna on 2026-09-27
(#740-#742, part of #689), read from every store. The design (inline payload +
read-by-chunk-address) is what made it a routing change.
