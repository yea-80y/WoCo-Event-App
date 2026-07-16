# Platform Feed Signer — What It Still Writes (audit 2026-07-14)

Verified by reading source, not by assumption. Every fact below cites `file:line`.

`writeFeedPage()` (`apps/server/src/lib/swarm/feeds.ts:227`) is the **single choke point**
for all server feed writes, and everything through it is signed by the platform key
`FEED_PRIVATE_KEY` (`config/swarm.ts:14`, and the standing TODO at `feeds.ts:195`).

So "is X platform-signed?" reduces to "does X go through `writeFeedPage`?".

**All of the below is paid for by the WoCo postage batch.** The batch is NOT limited to the
frontend + event directory. See the batch-routing section at the bottom — **which key signs**
and **which batch pays** are orthogonal questions, and this document is mostly about the first.

---

## By design — must stay platform-signed

| Feed | Where | Why it cannot be client-signed |
|---|---|---|
| Global event directory + creator index | `event/service.ts:1027,1035` | Discovery, multi-writer. No single client can own it. |
| Recovery status + guardian index | `recovery/service.ts:35,55` | The user has **lost their key** during recovery — a self-signed hint is unwritable exactly when needed. Holds no key and no escrow (`recovery/service.ts:25,39`); the real escrow is the SOC. The platform-signed *envelope* feed is LEGACY read-only (`recovery/service.ts:17`). |
| Site **pointer** feed + site events index | `routes/sites.ts:272-273` | The pointer is the discovery anchor that names the client's site feed signer. Site config + pages themselves ARE client-signed — the pointer is the only platform write on the modern path. |
| Claim ledger: `topicClaims`, `topicClaimers`, `topicPendingClaims` | `event/claim-service.ts:379,720,749,801,946` | `topicClaims` is the **slot-reservation ledger** — genuinely multi-writer shared durable state. See the rail asymmetry below before assuming this can be deleted. |

## Genuine gaps — single-writer data the user owns

| Feed | Where | Note |
|---|---|---|
| **Profile data** | `profile/service.ts:79` | ~~Unconditional platform write~~ **CORRECTED 2026-07-14: already client-signed.** The server *service* is unconditional, but its only caller (`POST /api/profile`) is reached solely by the client's no-signer fallback: `apps/web/src/lib/api/profiles.ts:172-226` writes the profile-data SOC client-signed whenever a content-feed signer exists (all login kinds except CSW), with `/verify-label` (`routes/profiles.ts:98`) covering the sub-ENS check. Same back-compat shape as the avatar. Remaining gap is **batch routing** (SOCs + avatar bytes stamp the WoCo batch) — see `docs/ETHERNA_USER_CONTENT_HANDOVER.md`. |
| **Shop config** | `shop/service.ts:171` | Platform-signed, no client-signed branch, despite being exactly analogous to site config (which uses pointer + client SOC). Shop is a post-launch/v2 feature — low priority. |
| User collection | `event/claim-service.ts:974,994,1000` | The user's own data, but written server-side during a claim. Tied to the claim-rail question below rather than independently fixable. |
| Legacy event detail feed | `event/service.ts:217` | Written **only** when the event has no `creatorFeedSigner` (`service.ts:215`). Phase B client-signed events never write it. Acceptable back-compat. |

---

## Claim rails are asymmetric (the important one)

There are two claim rails, and the on-chain one is **Stripe-only**:

- **On-chain rail** — `routes/stripe.ts:922` engages it only when the series has BOTH
  `onChainEventId` and `swarmManifestRef`, then calls `batchClaimForOnChain`
  (`stripe.ts:990`). No claims feed, no claimers feed, no collection write:
  *"there is no ClaimedTicket POD to stamp (the contract is the ledger)"* (`stripe.ts:1031`).
- **Swarm rail** — `routes/claims.ts:514` calls `claimTicket()` **unconditionally**. There is
  no on-chain branch. The only on-chain reference in that file (`claims.ts:562`) merely
  *reads* supply for claim-status.

The rail is decided by **route**, not by identifier. An email-identity buyer going through
Stripe DOES mint on-chain; a wallet buyer paying crypto through `/api/claim` does NOT.

| Route | Payment | Ticket minted |
|---|---|---|
| Stripe webhook, series registered on-chain | Stripe | **On-chain** (contract is ledger) |
| Stripe webhook, series not registered | Stripe | Swarm ledger |
| `POST /api/claim` (crypto-paid) | Verified on-chain (`verifyPayment`, quote + txHash consumed) | **Swarm ledger only** |

Crypto is an enabled path, not dead code: `FEATURES.cryptoPaymentsAllowed: true`,
`freeEventsAllowed: false` (`packages/shared/src/features.ts:6-9`). So today the payment
is on-chain but the ticket is not.

**Therefore the Swarm claim ledger is NOT removable legacy** — it is the live rail for
every claim that is not a Stripe purchase against a registered series. Deleting it breaks
crypto claims. The correct fix is to bring the other routes ONTO the on-chain/Swarm
hybrid, after which the Swarm-only ledger can be retired.

---

## De-platforming roadmap (added 2026-07-14)

Ordered by recommended sequence, not by ticket number. "Signer weight" = how much the
platform signer being in the path actually costs (trust the user must place in WoCo).

| # | Gap | Effort | Signer weight | Template already in repo | Notes |
|---|---|---|---|---|---|
| 1 | **Profile data** (#42) | — | — | — | **DONE before this audit** (see corrected row above) — the client-signed write shipped in `apps/web/src/lib/api/profiles.ts:172-226`. Superseded by the batch-routing task: user content still stamps the **WoCo batch**; move it to Etherna per `docs/ETHERNA_USER_CONTENT_HANDOVER.md`. |
| 2 | **Shop config** | Medium | Low (no shops live, v2) | **Yes** — site config (`routes/sites.ts:272-273`) | Same shape as sites: platform writes only the discovery **pointer**; config + pages are client-signed SOCs. Not launch-blocking; do it when Shop leaves v2. |
| 3 | **Crypto claim rail** (#41) | High | **High** (at the door) | Partial — Stripe v2 path (`stripe.ts:942`) mints on-chain already | The big one. Needs events to register with a real `priceBaseUnits` (today `0n`, `events.ts:756`) + buyers on the contract's permissionless `payAndClaimWithPermit`. USDC-only (single-token escrow); ETH is a later client-side swap, not contract work. Gated OFF for launch (`features.ts` `cryptoPaymentsAllowed:false`). |
| 4 | **User collection** | Falls out of #3 | Medium | — | Written server-side inside the claim (`claim-service.ts:974,994,1000`). Not independently fixable — it de-platforms as a consequence of #3 moving claims to the client/contract. |
| — | Legacy event detail feed | — | — | — | NOT a gap. Written only for pre-Phase-B events with no `creatorFeedSigner` (`service.ts:215`). Acceptable back-compat; just don't regress it onto the modern path. |

**Do NOT chase these — they are correctly platform-signed (see table up top for why):**
event directory + creator index, recovery status + guardian index, site **pointer** feed,
claim ledger (`topicClaims`/`topicClaimers`/`topicPendingClaims`). The claim ledger only
becomes retirable *after* #3, not before.

**Suggested first move for a dedicated pass:** #1 (profile) — low risk, ships standalone,
and proves the pattern end-to-end (client SOC on a single-writer user feed) before the
higher-effort #3. #3 is the one that actually removes the platform signer from the door.

---

# Batch routing — which batch PAYS (added 2026-07-14; IMPLEMENTED 2026-07-15, #48)

> **Status:** shipped on `feat/free-hosting-stripe-gate`. `writeFeedPage` takes an
> optional `dest` (BatchSelection); routed per the split below. Site feeds follow the
> site's home gateway (publish carries `gatewayUrl`, add/remove-event derives it from
> the directory `deployedUrl`); the event mini-site feed and legacy event detail feed
> follow the content's batch; avatar bytes + profile/avatar/site-config SOCs route via
> `batchForUserContent` / the client's Etherna gateway signal. NOT routed by design:
> claim ledger, collections, recovery, directory (purchase-path/paged), and the legacy
> profile-data feed (read-back-after-write UX). NEW CAVEAT — sequence-feed index
> continuity: bee's feed lookup walks indexes from 0, so if a feed's EARLY updates die
> with an old batch the lookup can fail even though the latest update is alive (same
> class as the paged-feed landmine below; our server-side index cache masks it until a
> restart). Fine while test data is expendable; at production cutover start fresh
> feeds or re-stamp old updates.

**Orthogonal to signing.** A postage stamp is not part of the signed data: a SOC signature commits
to `identifier + content address` only, never to the batch. Verified — an existing SOC was re-stamped
onto a different batch on a different node and returned the identical address. So re-routing the
batch changes **nothing** about signatures, topics, feed indices or content addresses.

## The four places the WoCo batch gets used

| Site | Code | Behaviour |
|---|---|---|
| **All platform feed writes** | `lib/swarm/feeds.ts:278` | `writeFeedPage()` passes `requirePostageBatch()` **unconditionally**. No router, no override. This is the single chokepoint. |
| Site pointer feed + feed manifest | `routes/site.ts:191,203` | Hardcodes `POSTAGE_BATCH_ID`, **bypassing the router entirely**. |
| Bytes uploads | `lib/swarm/bytes.ts:104` | `selection?.batchId ?? requirePostageBatch()` — defaults to WoCo when the caller passes no Etherna selection. |
| Client-signed SOC uploads | `lib/swarm/soc-upload.ts:190` | `dest?.batchId ?? requirePostageBatch()` — same default. |

`batchForDeploy()` (`lib/etherna/batch-router.ts:56`) governs **only** event/website *deploys*. Note
its fallthrough: `isWocoGateway || !isEthernaGateway` ⇒ anything not explicitly Etherna lands on the
WoCo batch. The client usually sends no `gatewayUrl`, so user content silently lands on WoCo.

## The constraint that decides the routing

**A batch can only be stamped by the node that holds it.** Our bee's `GET /stamps` returns exactly one
batch (the WoCo one); it cannot see, and cannot stamp with, the Etherna batch. Therefore:

> **Choosing a batch = choosing an upload path.**
> WoCo batch → local in-cluster bee (`http://bee-node:1633`), sub-millisecond, no external dependency.
> Etherna batch → external HTTPS to `gateway.etherna.io` + offer registration + gateway whitelist.

This holds even though **we own both batches**. Ownership is not locality.

**Corollary — batch choice does NOT affect readability.** Uploading to any bee pushes the chunk to the
public Swarm network; the storer neighbourhood is determined by chunk address, not by uploader. An
Etherna-stamped feed SOC is retrievable from our bee (measured: 200 in ~2s). We read everything via
`gateway.woco-net.com`. So **never** justify a routing choice with "X can't serve Y" — that reasoning
is void. The only real axes are **latency / failure-domain** and **who pays**.

## Recommended split

The axis is **write-path latency / failure domain**, NOT "platform vs user content".

Keep on the **WoCo batch** (local bee — written inside a purchase, or must work when all else fails):
frontend bundle · events directory + creator index ·
claim ledger (`topicClaims` / `topicClaimers` / `topicPendingClaims`) · user collections ·
recovery status + guardian feeds.

Move to the **Etherna batch** (cold write path — create/edit only, user-owned):
**event detail feeds** · profile data + avatar (SOC + bytes) · site config / pages / events index ·
site BZZ collections · POD + encrypted order blobs · shop config (v2).

**Rationale.** The claim ledger and user collections are written *inside a ticket purchase*
(`claim-service.ts:379,720,749,801,946,974,994,1000`). Routing them through an external gateway puts
`gateway.etherna.io` on the money path — a failure there is a charged card with no ticket. Recovery
feeds must work precisely when everything else is broken.

**Event detail is NOT hot-path — verified.** Every `writeFeedPage(topicEvent(...))` is in
`createEventV2` (`service.ts:217`), `confirmSeriesOnChain` (`:278`), `stampEventSubEns` (`:331`),
`updateEventMetadata` (`:460`) and `deleteEventIfNoOrders` (`:618`). **None is in `claim-service.ts`.**
It is written on create/edit/delete only, it is the organiser's own content, and on the modern path it
is already a client-signed SOC (`service.ts:217` fires only for legacy events with no
`creatorFeedSigner`). It goes to Etherna. Do not reason "platform-signed ⇒ must stay on WoCo".

## The WoCo batch ROLE is permanent; the current batch INSTANCE is not

`9ef3373b…` holds **test data**. Letting it expire is fine — desirable, even: it garbage-collects the
test events for free. What must not happen is the *role* going unfunded. Cut over to a fresh
production batch + fresh production events directory feed, then let the old one die. These are not in
tension: **the role is load-bearing, the instance is disposable.**

## LANDMINE — paged feeds and partial re-routing

Re-routing only changes **future** writes. Old versions keep their old postage. For most feeds that's
fine (you only read the latest version), **but paged feeds are not** — `topicClaims/pN`,
`topicUserCollection/pN`, directory pages. If only the *last* page is ever rewritten, pages 0..N-1
keep the old batch's postage and die with it, silently gutting the ledger.

**Currently harmless:** we are still in TESTING and existing data is expendable (user, 2026-07-14).
**Before launch:** either re-stamp old pages (`PUT /stewardship/{ref}` + `Swarm-Postage-Batch-Id` —
verified to work, re-stamp is NOT deduped) or keep paged feeds on a single batch. Do not let a paged
feed straddle two batches with different expiry dates.
