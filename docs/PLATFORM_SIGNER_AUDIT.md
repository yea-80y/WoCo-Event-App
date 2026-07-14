# Platform Feed Signer — What It Still Writes (audit 2026-07-14)

Verified by reading source, not by assumption. Every fact below cites `file:line`.

`writeFeedPage()` (`apps/server/src/lib/swarm/feeds.ts:227`) is the **single choke point**
for all server feed writes, and everything through it is signed by the platform key
`FEED_PRIVATE_KEY` (`config/swarm.ts:14`, and the standing TODO at `feeds.ts:195`).

So "is X platform-signed?" reduces to "does X go through `writeFeedPage`?".

**All of the below is paid for by the WoCo postage batch and served by the WoCo gateway.**
The batch is NOT limited to the frontend + event directory.

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
| **Profile data** | `profile/service.ts:79` | Unconditional platform write, **no Phase B branch**. Inconsistent with its own sibling: the *avatar* already does it correctly (`writeFeed:false`, `profile/service.ts:118-125`) and lets the client sign the SOC. Straightforward oversight. |
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
| 1 | **Profile data** (#42) | Low | Medium | **Yes** — avatar (`profile/service.ts:118-125`) | Mirror the sibling: `writeFeed:false`, client signs its own SOC, platform writes only the pointer if one is even needed. The single cleanest win — the correct pattern lives 40 lines below the broken one. Ship first. |
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
