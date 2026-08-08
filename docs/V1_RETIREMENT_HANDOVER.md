# Retiring the v1 claim rail — handover

STATUS 2026-08-08. Branch `fix/retire-v1-claim-rail`, worktree
`~/projects/woco-wt-v1retire`, cut from `origin/main` (4d2f87e). NOTHING PUSHED.
Phase 1 committed and green (tsc clean, 572 tests pass). Phase 2 not started.

## What this replaces

Issues #196 (claim feeds share one global namespace keyed on a client-chosen
`seriesId`) and #178 (the authorisation join that tried to fix it, and is
bypassable). The original plan was to re-key three platform-signed feeds on the
server-minted `eventId` across 16 files. **That plan was abandoned.** Measuring it
turned up the reason: those feeds belong to a rail that was already replaced.

`f951652` (2026-06-29) retired the editions feed. v1 allocates an edition by
scanning it, and `selectFreeSlot` skips every page whose editions data is null —
so with no feed it skips all of them and the claim throws "No tickets available".
The v1 rail cannot mint for anything created since June. Hardening it would have
been 16 files of money-path change to protect a path that already fails.

Owner decision: **v1 is never used again.** Retire it rather than namespace it.

## Verified facts this rests on (read in source / live, 2026-08-08)

- `isV2 ⟺ series.swarmManifestRef && series.onChainEventId` (`stripe.ts:1163`).
  v2 = the WoCoEvent contract is the supply ledger.
- All 4 events in the public directory are v2 (`onChainEventId` AND
  `swarmManifestRef` set on every series), all test data, two creator addresses.
  Their ids and creator addresses pass the new charset unchanged.
- No editions write exists anywhere — not `apps/server/src`, not `apps/web`.
  `editionsContentTopic` has zero client callers. `service.ts:189` writes `podRefs: []`.
- Every consumer already has a working v2 branch: `stripe.ts:1224`, `orders.ts:52`,
  `checkin.ts:189`, `claims.ts:610`, `reservations.ts:116`.
- An unregistered event never reaches the public directory — the snapshot is
  rebuilt on register-success (`service.ts:261`).
- v2 slot owners are per-ticket BURNER addresses (`claimFor(eventId,
  burnerAddress, orderRef)`), so the buyer's parent address never appears on chain.

## Phase 1 — DONE

    e443aab  Orders and check-in read the contract only — drop the Swarm fallback
    058417c  Revert "Refuse checkout for a series that never finished registering"
    59795f1  (reverted — premature; the webhook already auto-refunds)
    75006a8  Make a series id that reaches across the page separator unrepresentable (#197)
    aca9b5f  Turn the agent-commerce rail off: it charges the buyer and mints nothing

`aca9b5f` and `75006a8` are independent of the retirement and stand on their own.
#197 closes a live collision: `seriesId "abc/p1"` at page 0 built the same topic
string as `"abc"` at page 1. Charset is LOWERCASE `^[0-9a-z-]{8,64}$` — the issue's
`a-zA-Z` is wrong (two byte forms of one id). `/p{N}` encoding now lives in one
`pagedTopic` helper. `apps/server/test/topics.test.ts` pins the topic strings
byte-exactly — those strings ARE the feed addresses.

## Phase 2 — TO DO

### Purely subtractive (dead `else` beside a working v2 branch)

`claims.ts:632` · `reservations.ts:121` · `stripe.ts` webhook v1 branch (~:1332)
and the save-order claimers poll (~:1594) · `attendee-emails.ts:55`
(`broadcast-jobs.ts:262` already handles v2 via `allowUnproven`).

NOT validated by review — each row needs its own eyes before cutting.

### Delete outright

`lib/event/claims-feed.ts` · `lib/event/claimers-feed.ts` ·
`lib/event/pending-claims-feed.ts` · `routes/approvals.ts` · tests
`claims-feed.test.ts`, `pending-claims-feed.test.ts`.
From `topics.ts`: `topicClaims`, `topicClaimers`, `topicPendingClaims`, `topicEditions`.
From `claim-service.ts`: `claimTicket`, `getClaimStatus`, `approvePendingClaim`,
`rejectPendingClaim`, `getPendingClaimsFeed`, the three queue maps, `walletHandle`,
`claimHandleMatches`, `enqueueClaimersAttach`. **KEEP `hashEmail`** — the email-link
bind at `attendee-gate.ts:292` needs it.
Also delete `attendee-gate.ts` POST `/bind-wallet` (see below) and the untracked
`lib/event/series-rail.ts` (an abstraction created then abandoned — it models a
v1/v2 distinction this work removes).

### The subtle part — three fail-closed fixes

Review found all three; do not skip them.

1. **`service.ts:643` delete-safety.** `:639-641` ALREADY does the on-chain
   `nextSlot` read. The `else` being deleted is for series WITHOUT
   `onChainEventId`, where there is no id to query — so there is nothing to
   "substitute". A series that cannot be verified must **fail closed** (refuse
   the delete), not read as `claimed = 0`. `:652-662` reads pending-claims for
   EVERY series including v2 — it sits outside the branch, so it must go in the
   same commit or the build breaks.
2. **`getOnChainEventV2` (`event-contract-v2.ts:91-95`) catches everything and
   returns null**, so a transport failure is indistinguishable from
   EventNotFound, and `service.ts:641` maps null to `claimed = 0`. Latent today.
   After this cut the chain read is the ONLY delete-safety check, so an RPC
   outage would permit deleting a sold-out event. Fix as part of this work.
3. **`agent.ts:158` `gateRejection`.** `?? 0` on the tier count fails OPEN and
   contradicts the function's own documented "fails closed" contract — a tiered
   gate would open when it should be shut. Also needs `onChainEventId`/`chainId`
   plumbed in from the caller. Reachable only if `agentCommerceAllowed` flips back.

`nextSlot` is a next-index == slots ever allocated, monotonic (V2 refunds set a
`refunded` flag rather than freeing the slot), so it OVERCOUNTS after refunds.
That is the safe direction for delete-safety and matches v1's behaviour for gates.

### bind-wallet is dead — delete, do not port

`attendee-gate.ts:317` asks "which editions does this wallet hold" via the claims
feed. v2 slot owners are burners, so no chain read answers it, and every v2 call
already exits 404 at `:319`. There is no correct v2 answer: Stripe buyers are not
identified by wallet at purchase, and the v2 unlock path is the email-link bind
directly above it. If the crypto rail returns (#41), rebuild it on
`querySlotsOwnedV2` keyed by the paying address — a new design, not a resurrection.

### Preconditions and ordering

**There is no data precondition. WoCo is pre-launch with no customers and no real
organisers.** The four events in the directory are the owner's own test events and
are being deleted. Do not gate this work on inspecting them, do not write
compatibility paths for them, and do not ask whether they hold state — delete
freely and let them break. An earlier draft of this document asked for a
pending-approval sweep; that was wrong and has been removed.

- **Reject `approvalRequired` at event creation** — otherwise organisers can set
  a flag whose behaviour is now undefined.
- **Same-commit atomicity** or the build breaks: `service.ts:643` + `:652-662`
  with the claim-service deletions; `attendee-gate.ts` bind-wallet with
  `getClaimStatus`; `agent.ts:158` with `getClaimStatus`.
- **Frontend callers** of bind-wallet and the approvals endpoints must go in the
  same cut, or they hit Hono's plain-text 404 and `authPost` throws the known
  "Unexpected non-whitespace character" parse error. `/claim-status`'s
  `userPendingId` and ClaimButton's pending UI lose their meaning too.
- **Consequence to accept:** deleting the v1 claim route removes the only
  free-ticket path. `freeEventsAllowed` is already `false`, so nothing live
  changes, but free events would need a v2 mint path before that flag can flip.

## Issues to file (not yet filed)

- Registration split-brain: tickets sold via the v1 fallback before on-chain
  registration succeeds are orphaned the moment `isV2` flips true. Retiring v1
  removes the mechanism; the issue records why the fallback was a trap.
- `orders.ts:60-67` fans out one RPC per slot via unbounded `Promise.all`, and the
  endpoint has no pagination — a large event fires thousands of concurrent calls
  and returns every order in one response. `checkin.ts:194` already does it right
  with `mapWithConcurrency`; copy that.
- `approvalRequired` on a paid v2 series is undefined behaviour (adjacent to #119,
  which this work removes by removing the feature).

The Para key in repo history is CLOSED, not outstanding: it is a sandbox key with
no use, Para is deleted from the codebase, and the owner has ruled it a non-issue.
Do not raise it again.

## Working with Fable

**Fable does phase 2 — writing, not just reviewing.**

It does best on one topic with a named file list, no repo-wide greps, and
`git show <sha>` rather than `git log -p`. If the work is split, the natural seams
are (a) the subtractive deletions, (b) the three fail-closed fixes, (c) bind-wallet
and the frontend callers.

Its record on phase 1: it caught the Hono `%2F` path-decode gap, the unverified
editions-write precondition, the incoherent delete-safety substitution, the
`getOnChainEventV2` fail-open, and that bind-wallet was already dead — all things
the main session had wrong.

## Starter prompt for a fresh session

    WoCo (~/projects/woco-wt-v1retire, branch fix/retire-v1-claim-rail, nothing pushed).
    Read docs/V1_RETIREMENT_HANDOVER.md in full first. Phase 1 is committed and green.
    Do Phase 2: retire the v1 claim rail — delete it, do not harden it.
    WoCo is PRE-LAUNCH: no customers, no real organisers, the test events are being
    deleted. No compatibility paths, no data preconditions, nothing to preserve.
    Don't re-derive the decisions in the doc; the three fail-closed fixes are the risk.
