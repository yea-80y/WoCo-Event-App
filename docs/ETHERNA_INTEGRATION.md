# Etherna Gateway Integration

> **Reconstructed 2026-06-21** (the original `ETHERNA_INTEGRATION.md` was deleted).
> Rebuilt from memory (`project_etherna_integration`, `project_etherna_legacy_soc`,
> `project_etherna_batch_registry`) + current code. Verify file:line against the
> tree before relying — the surviving companion is
> `ETHERNA_COMMIT4_HANDOVER_2026-05-18.md`.

## Purpose

Migrate WoCo off its self-hosted Bee + bee-proxy toward Etherna's hosted gateway
(`gateway.etherna.io`, a Bee fork called **Beehive**). End state = everything on
Etherna; we retire our own Bee node. **Do not propose alternatives** (the owner has
explicitly rejected `gateway.ethswarm.org` and keeping our Bee for end-user reads).

## Current routing (phased — verified in `apps/server/src/config/swarm.ts`)

| Path | Bee instance | Batch | Notes |
|---|---|---|---|
| **Main app feeds** (events, profile, claims, recovery escrow) | **our own Bee** — `getBee()` (`BEE_URL`) | our platform batch — `requirePostageBatch()` (`POSTAGE_BATCH_ID`) | signed by the platform key `FEED_PRIVATE_KEY` |
| **Per-deploy site content** (multisite collections + pointer feed) | **Etherna** — `getEthernaBee()` (`lib/etherna/upload.ts`) | Etherna batch (platform shared, or per-user — see batch model) | bearer-token auth |

So `getBee()` **always** talks to our local/own node; Etherna is reached **only**
through `lib/etherna/upload.ts`. A single `ETHERNA_ENABLED` flag is too coarse — any
new Swarm write must consciously choose its target.

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
- The provisioned depth-20 platform batch (`fc957ecd…956bb9a`, ~688 MB, from
  2026-04-30, ~45-day TTL) is the shared one; check/buy via
  `etherna-batch-check.ts` / `etherna-buy-platform-batch.ts`.

## Key files & scripts

- `apps/server/src/config/swarm.ts` — own-Bee client, platform signer/owner, batch.
- `apps/server/src/lib/etherna/upload.ts` — Etherna Bee, collection upload, offer
  register, raw-HTTP feed/SOC write.
- `apps/server/src/lib/etherna/auth.ts` — Etherna OAuth bearer token.
- `apps/server/scripts/etherna-*.ts` — batch check/buy, chainstate, feed/SOC probes.

## Env vars

`ETHERNA_ENABLED`, `ETHERNA_GATEWAY_URL` (default `https://gateway.etherna.io`),
`ETHERNA_API_KEY` (→ bearer token), plus the own-Bee set (`BEE_URL`, `PROXY_URL`,
`POSTAGE_BATCH_ID`, `FEED_PRIVATE_KEY`).

## Relevance to client-side feed signer / recovery

See `CLIENT_FEED_SIGNER_HANDOVER.md` → "Etherna compatibility". The recovery
portability envelope stays on our own Bee for Phase A (no Etherna dependency), and is
designed Etherna-safe (inline payload + read-by-chunk-address) so the end-state move
is a routing change, gated behind the SOC probe.
