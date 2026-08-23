# WoCo App — Devlog

Running history of completed work and roadmap. Stable architecture and conventions live in `CLAUDE.md`.

---

## Recovery onto an email sign-in scans the chain for every account that sign-in owns — the cross-device collision is closed (#234, 2026-08-23)

`recovery-owner-collision.ts` refused to hand an account to a credential that already had
one, but its evidence was per-device (binding, seed, caches) plus one per-counterfactual chain
point-read — and a RECOVERED account lives at a preserved address no per-credential read can
reach, so two recoveries onto the same email on two devices both passed. Kernel v3.1's ECDSA
validator emits `OwnerRegistered(address indexed kernel, address indexed owner)` from
`onInstall` (its sole owner writer), on recoveries as well as deploys, so `eth_getLogs(topics[2]
= credential)` is the authoritative owner→account record with no server and no new write.
`owned-accounts-scan.ts`: paged (10M blocks; ZeroDev answers a page in ~1.4 s, measured), head
snapshotted once, any page failure aborts as `unknown` (never partial), every hit re-read LIVE
with a tri-state owner read that aborts the whole check on a single error, target + own
counterfactual excluded; union argument, polarity (fails CLOSED, opposite of the guardian
pre-flight, with the passkey route as the escape hatch) and "accident prevention, not
enforcement" written into the module. Runs only on the web3auth branch and only after the
cheaper evidence allows; a tail re-scan after the rotation confirms (pre-scan head − reorg
margin → now) makes the same-moment race loud: refuse the local commit and route to a
passkey re-recovery. Evidence field `ownedAccountsScan` on `decideOwnerCollision`; the email
option in the portal says the check can take a minute or two.

---

## The SOC relay's fallback read is verified and source-listed: a 404 is a verdict, a 503 is "could not ask", and the client checks the signature (#156, 2026-08-23)

`GET /api/swarm/soc/:owner/:identifier` returned a bare payload the client decoded and
believed — the one read path with no signature check, so the API origin was a trust root for
every client-owned feed (profile, event detail, editions, site config, backup manifest: forgery;
sealed envelopes: rollback) — and its 404 came from a reader whose `null` meant "absent OR
bee 500 OR Etherna unreachable OR bad token OR timeout", which the client caches as a verdict
(#138). Now `lib/swarm/soc-read.ts` reads the raw STORED chunk from an ordered list of
sources, each answering found / absent / unavailable with a declared negative authority,
verifies it (identifier, span, signature recovers to owner — a source that answers with other
bytes is treated as unreachable, not absent), and aggregates: any verified found → found; any
source unreachable → 503 `unavailable`; every verdict source absent → 404. Our bee is the
verdict source (the deployed node answers `404 chunk not found` after a full ~2 s search —
verified 2026-08-23; its 500 "read chunk failed" is a retrieval fault, no longer not-found).
Etherna is consulted only when the caller's `gatewayUrl` says the feed is Etherna-stamped —
the write-path probe forwards it — so an Etherna outage makes an Etherna-stamped write
refuse (honest) and never touches a WoCo-stamped one. The route returns the WHOLE SOC;
`swarm/soc-verify.ts` re-runs the same checks in the browser before `probeSoc` reports
`found`. Adding a gateway, a user's bee or a browser node is one entry in `sourcesFor`.
Still open: the client's own source list (gateway, then server) is hard-coded — tracked
separately for the browser-node work.
## Recovery API + relay hardening: auto-find moves to a guardian-owned SOC; the recovery routes and the SOC relay get rate limits and body caps (#157, #176, #301, 2026-08-23)

**#157.** The guardian→account reverse index was a platform feed the server wrote from a
caller-supplied `guardianAddress` — world-writable (any authenticated account could claim any
guardian, so a locked-out user connecting their backup was auto-found to the attacker's Kernel and
told "no backup found") — and `GET /status/:kernel` handed out the guardian + sub-ENS label for any
public Kernel address. Patching the server write was rejected: an on-chain-gated write still lets a
sponsored userOp register the victim's guardian on the attacker's own Kernel, and the hook's first-
install event (`GuardiansSet(account, address[])`) has the guardian unindexed, so a chain-derived
reverse lookup is not a cheap log filter. Instead the index is now **`GuardianAccountIndex`, a SOC
owned by the guardian's own signer** (the key derived from the backup wallet's signature that already
owns the escrow): only the backup holder can write it, its address is not computable without that
signature, and the server neither writes nor serves it. Setup upserts the account after the on-chain
install; the portal derives the keys from the connected backup (the ceremony's first signature,
moved earlier and reused — wallet backups still sign once), reads the index, and confirms every
listed account against the chain (`isGuardianRegistered`) before "Protected account found". That
chain check replaces the tombstones (a replaced backup's stale entry is filtered exactly). Server:
`/by-guardian`, the index writes, `tombstone.ts` and `MAX_CLEAR_GUARDIANS` are gone; the presence
doc is `{ v, configured, updatedAt }`; `/escrow` takes no body; `/escrow/clear` only flips the hint.

**#176 / #301.** `lib/http/rate-limit.ts` is one sliding-window limiter (burst + sustained
windows, peek/record, bounded key count with stale-first then LRU eviction) and `body-limit.ts` a
JSON-shaped 413 mounted before `requireAuth`. Recovery POSTs: 6/min + 20/h per parent, 30/min +
120/h per IP, 8 KB bodies; GETs 120/min per IP. The SOC relay (`/api/swarm/soc`): 60/min + 500/h
per parent, a tighter 30/min + 300/h bucket for statement-shaped payloads (classified from the
payload's own `format`), 300/min + 3000/h per IP, a 1500/min global ceiling that answers 503 and
trips `/api/health` `swarmRelay.globalTrippedAt`; `/bytes` (no in-repo caller) tighter still.
`/api/*` has a 16 MB body backstop.

---

## Recovery: a WoCo-owned guardian hook with set-semantics and a real revoke; one guardian config, two derivations that must agree (#164, #161, 2026-08-22)

The ZeroDev caller hook pinned guardians in an append-only `allowed[guardian][kernel]`
mapping with no revoke, and Kernel v3.1's selector uninstall never reached its
`onUninstall` — so a replaced backup kept takeover power and "remove all, add one"
resurrected every past guardian (#148). Kernel overwrites a route's hook unconditionally,
so a different hook is the supported per-guardian revoke. **`WoCoGuardianHook`**
(`contracts/src/recovery/`, 21 Foundry tests incl. fuzz) is live on Arb Sepolia at
`0xF43524473EBC651969BeCc748462ED27ed39d4Db` (CREATE2 singleton, verified): `onInstall`
SETS the set, `addGuardian`/`revokeGuardian`/`clearGuardians` edit it from the account's
own sudo `execute`, `guardiansOf`/`isGuardian` are chain truth. Every route is now installed
against it; routes still on the ZeroDev hook are recognised (`hookKind: "legacy"`), keep
recovering, and are REPLACED by the next add (the confirm step says so). The setup screen
lists the on-chain set with a per-backup **Remove** (proven by pinned read-back), "add
another" APPENDS, and the resurrection warnings are gone because the hazard is. Proven
live on a real Kernel route by `apps/web/scripts/recovery-hook-harness.ts` (19/19: refusal,
recovery, revoke, append, re-install does not resurrect). Server: `keepStatus` on the
clear-hint route so a single revoke does not flip the presence hint.

#161: `guardian-config.ts` is the ONE definition of the guardian set (was hand-written in
four places); `guardian-address.ts` replays the CREATE2 derivation SDK-free and is pinned by
test to EntryPoint-observed addresses plus the SDK's shipped constants and enable-data bytes —
a `@zerodev/*` drift is a red build, offline. `deriveGuardianAddress` (setup) and
`recoverAccount` assert SDK-built == pure before sending; installs read the registration back.

## Kernel-owner reads are ordered by L2 block — a lagging replica cannot readmit a retired key (#200, 2026-08-22)

`isKernelOwner` decides session authority from the account's live ECDSA owner, read at
`latest` through a public, load-balanced RPC. #277's re-read-on-rejection meant every
retired-key request asked the chain again — and a replica lagging behind the recovery
answered with the retired owner, which was then cached as current for another TTL.
Reads now fetch `(ArbSys.arbBlockNumber, owner)` in ONE `eth_call` via Multicall3
(verified live; the EVM `block.number` on Arbitrum is the L1-ish value and cannot order
reads), and `kernel-deployed.json` (v2) remembers `{owner, block}` per Kernel. A read
naming a DIFFERENT owner from a block no later than the last observed change is
discarded — not cached, refused for a known-deployed account. Same-owner reads are
accepted at any block (steady-state jitter never 403s). A different owner at a later
block is a rotation: logged, record advanced, so web3auth→passkey→web3auth re-admission
works where a "retired set" would not. Pure judge in `lib/auth/kernel-owner-ordering.ts`.
This is memory of chain facts, not authority — it can only withhold, never grant.

**Not built, with reasons on the issue:** revoke-all at rotation. `issuedAt` is
client-chosen within the ±5 min skew window, so a retired key simply re-mints past any
stamp — the owner check is the enforcement — and no stamp is wart-free for the
legitimate new owner's own first session. **Remaining:** the ≤TTL coast while the
recovered client has not yet contacted the server (closed at finalize by the companion
client PR), and the lost-store + RPC-failure case, whose mitigation is the file's
durability.

**Bounded the same path (#163, #210), same day.** It runs before any authorization, so its
keys are caller-chosen and every cache miss is an eth_call on the RPC the payment path
shares. Now: both caches capped (oldest evicted); concurrent
requests for one Kernel share one read; a read happens only within the caller's per-client
budget of UNCACHED reads (`owner-read-budget.ts`, 120/min, drawn only when verification
reaches the chain — cache hits and EOA parents cost nothing; over budget = "error", which
can only withhold); and a store record is CREATED only by a confirmed read (the chain named
the presenting key), so foreign ZeroDev Kernels no longer fill `kernel-deployed.json` or
force a fsync per request — an existing record is still updated by any fresh read, and a
cache-hit confirmation records the account when the store has none. Rejected, test-pinned:
the counterfactual short-circuit (#163's suggestion) — a retired key would never be read;
store eviction (#210's suggestion) — eviction fails open, bounding creation does not; and a
server-side negative cache for failed reads — client.ts already throttles after a double
failure, and any server window defeats its one immediate retry on a blip → banner.

## Claim feeds: page them, and stop lenient reads driving writes (2026-08-01)

`encodeJsonFeed` pads a JSON document into ONE 4096-byte feed page and throws once
gzip cannot make it fit. Two per-series feeds were sitting under that ceiling with
no paging: claimers (~30 entries, PR #112) and pending-claims (~16 — an entry
carries a UUID, an AES-GCM sealed address and two Swarm refs). Pending is the
worse of the two because decided requests are kept as history, so it only grows.
Both now use the user-collection idiom: the existing v1 page IS page 0, overflow
spills to `/pN`, readers probe to the first gap, and the spill/move logic lives in
pure planners with the encoder injected as a `fits` callback.

**The finding that mattered came from the review, not the feature.** The paging
code read pages with `readFeedPage`, which collapses a transient Swarm error into
the same `null` it uses for "never written" — and a writer that believes a page is
missing *replaces* it. One read blip would publish a page holding only the new
entry and drop every request already on it, leaving them undecidable with their
claims slots reserved forever. `feeds.ts` already spelled the rule out ("write
paths that read-modify-write a directory MUST use the strict variant"); the code
did not follow it. Write paths are strict now, and the fail-closed semantics are
under test rather than asserted in a comment.

Two more came out of the same read. Reject cleared a claims slot without checking
it still held that request's reserved ticket — against a phantom "pending" record
that revoked an issued ticket and put the edition back up for sale. And both
decision paths fell back to a *blank* claims page when the read returned null,
which erased every other claim on it. Both fixed.

**Serialisation.** The pending feed had two writers on two unrelated queues, and
approve/reject read the whole document, did seconds of Swarm work, then wrote that
stale snapshot back — a claim landing in the window was erased. One per-series
chain now, and decisions re-read inside it and patch the entry.

Moving an entry between pages is safe because `claimerSealed`'s AAD binds
`{seriesId, pendingId}` — per-entry context, not per-page. A test asserts the
ciphertext is byte-identical after a move.

Left open, each with an issue rather than a fix, because they are the hot claim
path and deserve their own review: #113 (an unreadable claims page reads as empty
in `claimTicket`'s slot scan — wipes claims and double-assigns editions), #114
(the same lenient-read hole in `claimers-feed.ts`), #115 (approve/reject rewrite
claims pages outside `queueSeriesClaim`), #116 (agent rail bypasses that queue).

---

## SES migration + the silent ticket-email failure (2026-07-30)

AWS granted production access that morning — 50k/day, 14 msg/s, eu-west-2, out of
sandbox — so the migration was pulled forward ahead of both triggers in
`PRICING_AND_EMAIL.md` §6. The reason was not cost: a cold SES domain warms on
volume history, and the cheapest time to accumulate that is pre-launch when
volume is near zero. Full handover, including the AWS console steps that must
happen before the flag is flipped, in `docs/SES_MIGRATION_HANDOVER.md`.

**The bug worth naming.** `stripe.ts` fired ticket email with
`.catch(err => console.error(...))`. A buyer paid, the send failed, the evidence
went to docker logs, and nobody found out until they were turned away at the
door. Three things now have to hold: transient failures retry with jittered
backoff, transactional mail fails over to a secondary provider, and anything
finally abandoned lands in `.data/email-failures.json` — which flips
`/api/health` on any unresolved *transactional* failure, because one person who
paid and has no ticket is already an incident. The webhook still returns 2xx to
Stripe (non-2xx would redeliver and re-run the whole claim path over an email
problem) but the loss is no longer invisible.

**Rate, and a regression I am flagging rather than hiding.** `SEND_CHUNK = 5` at
~200ms each is ~25 req/s against a 14/s grant, and SES answers
`TooManyRequestsException`, which the old marketing loop counted as `failed` with
no retry. A token bucket at the `sendEmail` chokepoint now shapes all traffic
against one account-wide budget — the limit is per-account, so a per-caller
limiter would let a broadcast and a burst of ticket email each stay under it
while together blowing through. Transactional drains ahead of marketing, so a
1,000-recipient broadcast can no longer queue ahead of the buyer who just checked
out. The cost: that broadcast now takes ~83s at 12/s, uncomfortably close to
Cloudflare's 125s origin timeout. The old code was faster and wrong; this is
correct and slow. **The background broadcast queue is now the most urgent gap.**

**SESv2 `Simple` content, not `Raw`.** Simple content carries an `Attachments`
list with `ContentId` + `ContentDisposition: INLINE`, which is what
`cid:woco-card-0` in the ticket email needs — so SES assembles the MIME and we
added no MIME builder and no `nodemailer`. One new dependency:
`@aws-sdk/client-sesv2`.

**SNS bounce/complaint webhook.** AWS required bounce handling as a condition of
production access. `lib/email/sns-verify.ts` verifies signatures with
`node:crypto` — the whole job is a canonical string plus an RSA verify against a
cert from a host-allowlisted HTTPS URL, and a package for that is more
supply-chain surface than code saved. Unconditional, because a forged complaint
would globally suppress an arbitrary address. Policy: every `Permanent` bounce
subtype and every complaint suppress; `Transient` and `Undetermined` do not —
permanently blocking someone over a full mailbox means they never get a ticket
again. The topic ARN is pinned and the route **fails closed** without it: a
genuine SNS signature only proves Amazon sent the message, and any AWS customer
can get one by publishing on their own topic.

**Resend kept, scoped, and dated for deletion.** It stays on the free tier as the
operator rollback lever and as automatic failover for transactional mail only.
Ticket email runs under 1,000/month so the free tier absorbs an SES outage; one
broadcast would exhaust the 100/day allowance and start a cold domain on bulk
mail, so marketing never fails over. Delete when phase 2 (per-organiser sending
domains, SES-only) ships, or 2026-10-01, whichever is first.

**Reviewed, and the review earned its keep.** Fable found four defects. Two were
mine re-creating the bug I was fixing: `acquire()` sat outside the `try`, so a
full send queue threw straight past `recordFailure` into the Stripe webhook's
`console.error`; and `prune()` sliced newest-1000 regardless of kind, so one
failed 1,000-recipient broadcast — which happens precisely when transactional
sends are also failing — evicted every paid-ticket failure and flipped
`failureHealth()` back to green. Also an Art. 17 gap (`eraseSubject` did not
cover the new plaintext store) and two now-false sentences in
`DATA_INVENTORY.md`. All fixed in `757d57e`.

It also settled the SNS canonical-string ambiguity — both AWS-authored validators
build `name\nvalue\n` including the final pair, so the trailing form is correct
and the dual-encoding branch is gone.

**One finding is still open and blocks cutover.** Async bounces never reach the
ledger: a typo'd email at checkout is *accepted* by SES, so the send resolves with
no ledger entry, and the hard bounce minutes later only suppresses a hash. The
silent-failure fix therefore covers synchronous API failures — about half the
failure surface. Status board and fix shape in `SES_MIGRATION_HANDOVER.md` §4a.

93 tests added, 285/285 server green, `build:server` clean. Not yet cut over —
`EMAIL_PROVIDER` still defaults to `resend`, deliberately: flipping the default
would take email down on any VM whose env lacks AWS credentials.

## Pre-launch review follow-ups: #80, #82, #83, #81, #85 (2026-07-29)

Five issues from the 2026-07-28 pre-launch review, each verified against source
before any code was written. Five commits, 61 new tests (server 159/159, shared
102/102, build:web clean).

**#80 — consent dead-end (the one with a real victim).** `ClaimButton` records a
shown-but-untouched opt-in box as an explicit refusal (deliberate PECR reg. 22
posture), and the suppression store had no way back: first mark wins, forever.
Ignore the box at event A, tick it at event B, and you got an Art. 7(1) consent
record that every send silently contradicted. Marks now carry `liftedAt` instead
of being deleted — the refusal survives as the audit record while no longer
suppressing — and `liftDeclineOnConsent` lifts ONLY a per-org `"declined"` mark
on strictly newer evidence. `unsub`/`bounce`/`complaint`/global are untouchable;
resubscribe stays the double-opt-in flow in #60. Building it surfaced a second
defect: `suppressOrg` stamped the WRITE time, so a card sale recorded minutes
later in the Stripe webhook looked newer than the decision and swallowed the very
opt-in that should have lifted it. It now takes the decision timestamp.
`consent-capture.ts` is the single writer for both call sites — the drift between
them is what caused this.

**#82 — broadcast hardening.** Rate-limit TOCTOU (checked at the top, recorded
after a slow send, no lock — N concurrent requests all passed) now runs
check-and-consume under `withOrgLock` before the send. Rate map lowercased. And
the v2 fallback was scoped: ONE on-chain series used to disable the
per-recipient attendee check for the WHOLE event, so a verified organiser could
mail arbitrary addresses through any event with an on-chain series attached.
Membership is proven against the v1 claimers feeds first; only the unaccounted-for
remainder reaches the verification gate.

**#83 — Art. 17 wired.** `forgetEmailHash` had zero callers; erasure meant
hand-editing `.data/*.json`. `lib/marketing/subject-request.ts` +
`scripts/data-subject-request.ts` (a script, not an admin route — there is no
admin identity here and inventing one is a worse surface). Suppress FIRST, then
erase: a crash between the two over-suppresses rather than leaving an erased
consent record with nothing barring the next contact upload. Scoped erasure so a
request naming one controller does not destroy every other organiser's evidence.
Log hygiene: a failed send logged the plaintext recipient into docker logs.

Production hardening that fell out of it: the three compliance stores used plain
`writeFileSync`, which truncates before writing. A crash or full disk mid-write
leaves an unparseable file, and every loader treats unparseable as "doesn't exist
yet" — the suppression list would come back EMPTY and silently, i.e. mailing
people who unsubscribed. Now temp-file + fsync + atomic rename
(`lib/marketing/persist.ts`), with failures counted per store and surfaced on
`/api/health` as `compliancePersistence`.

**#81 — launch checklist, code half.** Legal placeholders filled from the
constants that make them true (`PLATFORM_FEE_BP=150` → 1.5%,
`POST_EVENT_RELEASE_DAYS=2`, `MAX_HOLD_DAYS_DEFAULT=90`); `[PRIVACY EMAIL]` →
privacy@woco-net.com in 5 places across 4 files (the issue said 3). Log retention
stated at 30 days + an active-investigation carve-out, with DATA_INVENTORY §8
rewritten to say what must still be CONFIGURED — docker's json-file driver
rotates on nothing unless told to, and a policy claiming 30 days over
infrastructure that keeps logs forever is worse than the placeholder was. Custom
sending domains closed behind `FEATURES.organiserSendingDomains`, gating UI and
the four `/api/marketing/domain` routes in lockstep. `scripts/backup-data.sh`:
snapshot-then-archive, refuses an empty source, verifies the tar reads back.

**#85 — payout follow-ups.** Shop ledger entries fall back to the shop's
`ownerAddress` (they released fine, but were invisible in the organiser-keyed
`GET /api/stripe/payouts`); the read is best-effort because an unrecorded sale is
far worse than a blank display field. Failed manual-schedule corrections now queue
and retry from the hourly sweep instead of waiting for another webhook that may
never come. `heldPastCeiling()` feeds `/api/health` — counts only, no amounts.

**#84 — pricing currency restricted.** An organiser may now only price in their
Stripe `default_currency`, cached on the accounts store and refreshed on
`account.updated`. Enforced server-side at event creation and mirrored in the
picker. The fail-open is the load-bearing part: Stripe assigns `default_currency`
during onboarding, so "unknown" is the normal state for a new organiser and
rejecting on it would block them from creating any paid event at all. An
organiser banking outside usd/gbp/eur keeps the full picker rather than being
locked out.

**#87 — a warning, no gate.** Stripe's 90-day limit runs from the CHARGE, so a
ticket sold >83 days before its event releases before the event runs.
ORGANISER_TERMS §6 already covers the refund obligation; what was missing was
telling the organiser at the moment they set a far-future date. No gate: near-term
events are inside 90 days, and a verified-only gate would be code deleted once
Managed Risk lands. The real control is the Managed Risk reconfiguration, which is
Stripe-side.

---

## Marketing audience + email compliance (2026-07-18, PR #58)

Organiser marketing stack: CSV import wizard (papaparse, consent-warranty gate),
contact lists ECIES-sealed client-side to the organiser's X25519 key (Swarm blob,
STRONG erasure coding — first use), server keeps only HMAC email hashes.
`sendMarketingBatch` = the single non-transactional send path (server-side
suppression re-check, RFC 8058 one-click unsubscribe, provenance footer); event
broadcasts retrofitted through it. Public `/u/:token` unsubscribe (HMAC token, no
expiry), Resend bounce/complaint webhook → global suppression, organiser sending
domains via Resend Domains API, 2/hr + rolling-24h daily send caps.

Fable audit (same day, two rounds):
- R1 fixes (`7b216ed`): footer insertion anchored to document-final `</body>`
  (hide-the-footer bypass); broadcast recipients hash-checked ⊆ imported list;
  cap checks + send + record serialised under per-org lock; control-char strip
  on fromName/subject; `/u` copy no longer promised a nonexistent resubscribe
  path; two frontend cleanups.
- R2 (security review): webhook signature verification made UNCONDITIONAL — no
  NODE_ENV gate; secret unset ⇒ acknowledge-and-drop, never parse-and-suppress.

Open decisions tracked in GitHub issues (see PR #58 body): abuse gate
(charges_enabled) before public launch, operational-vs-marketing suppression,
resubscribe flow, CAN-SPAM postal address, >1000-recipient batching, marketing
blobs must join the #45 batch cutover.

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

## Account abstraction (AA) wallets — roadmap

**Status** (2026-04-17): unsupported. Server rejects any payment tx where
`tx.from` is not an EOA matching the claimer. Smart-account wallets (Safe,
ERC-4337 bundled user ops, Argent, Biconomy) currently see a clear error:

> "Smart-account wallet detected. WoCo currently only accepts payments from EOA
> wallets. AA support is on the roadmap."

Detection sits in `apps/server/src/lib/payment/verify.ts`:
- `tx.to` against a set of canonical ERC-4337 EntryPoints (v0.6 / v0.7)
- `provider.getCode(tx.from)` — non-empty code means `tx.from` is itself a
  contract (Safe direct path)

### Why we don't just "allow AA"

The Round 2 hardening (2026-04-09) binds a payment tx to the claimer via
`tx.from === expectedFrom`. This defends against mempool front-running —
an attacker watching pending txs and racing the legitimate buyer to the
claim endpoint to reuse their payment.

For smart accounts this invariant is wrong:
- **ERC-4337**: `tx.from` is the *bundler*, not the user. The real signer is
  inside the `UserOperation` calldata.
- **Safe / proxy wallets**: `tx.from` can be any EOA owner (or a relayer), and
  authorisation is a multi-sig threshold inside the Safe contract.

Shipping a half-baked "if tx.from is a contract, trust it" would open a silent
hole: anyone paying through any smart account with any tx.from could claim on
behalf of any other address. Front-running defence broken.

### Proper AA support — design sketch

For a future branch, not a now task.

1. **Detect the wallet type** deterministically:
   - ERC-4337: tx targets a known EntryPoint. Extract the `UserOperation[]`
     from calldata. The `sender` field is the smart-account address; the
     `signature` field authorises the op.
   - Safe: `tx.to` is a Safe singleton/proxy; the `execTransaction` call
     contains the operation and threshold signatures.
   - Contract-based owner wallet (rare): generic ERC-1271 fallback.

2. **Verify signer authority** via **EIP-1271** — call
   `isValidSignature(hash, signature)` on the smart-account contract. Returns
   the magic value `0x1626ba7e` iff the signature is authorised by the
   account's owner(s). This abstracts over Safe thresholds, social-recovery
   schemes, passkey-based owners, etc.

3. **Rebind to "the smart account"**: the claimer's proven address becomes
   the smart-account address, not an EOA. Replay protection still holds:
   `claimerProof` is signed by an EOA owner, we verify via EIP-1271 that the
   smart account authorises it, then bind to the smart-account address.

4. **Test fixtures**: Safe v1.3/v1.4, Biconomy smart account, Argent, Kernel
   (ZeroDev). Each has a subtly different calldata layout.

5. **UX**: surface clearly which address is the claimer — the smart account,
   not the owner EOA — so the user understands their ticket is tied to the SA.

6. **Docs**: add an `AA_SUPPORT.md` spec in `docs/` before the implementation
   lands; this is exactly the kind of change that needs a review round.

### What you gain

Safe users (significant chunk of crypto-native orgs and DAOs), mobile users
on Argent / Coinbase Smart Wallet, anyone who pays through a session-key
wallet like Biconomy. These are the wallets Devcon-style events see most.

### What it costs

~1 week of careful work (including tests), a new attack-surface review, and a
bump in audit scope. Worth doing — just not in the same breath as a
confirmation-count bugfix.

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
