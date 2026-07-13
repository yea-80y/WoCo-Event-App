# Handover — make SiteBuilder events CLIENT-SIGNED (+ session context)

> Fresh-chat handover, 2026-06-24. Read `docs/CLIENT_FEED_SIGNER_HANDOVER.md`
> (Phase B) and the AUTH + SWARM sections of `CLAUDE.md` first.

## STATUS 2026-06-24 — Path A CODE-COMPLETE (committed, NOT pushed, NOT deployed)

Owner confirmed the model: a client-signed event is claimable once it's on the
organiser's DEPLOYED site (the site's server-written `SiteEventsIndex` is the
trusted carrier) — WoCo-listing NOT required. Crypto trustless path = separate
deferred work in `docs/CRYPTO_CLIENT_VERIFIABLE_PAYMENTS_PLAN.md` (Path B).

Commits (oldest→newest), each typecheck/build-clean:
- `62a8883` PublishButton: client-sign site events (drop skipAutoList from signing).
- `e1ffb11` `resolveSiteEventSigner(siteId,eventId)` — trusted carrier resolver
  (reads server-written `SiteEventsIndex`; bounded siteId guard added in `744f9fa`).
- `fcfaace` Stripe path: thread carrier into create-checkout (money: creatorAddress→
  Connect dest + amount) + webhook (issued-ticket metadata).
- `744f9fa` Direct-claim/reservation path: `currentSiteId()` (SITE_CONFIG) on claim/
  claim-status/reserve; server resolves carrier before `getEvent`. siteId rides the
  canonical-signed wallet-claim body (no signing-model change).
- `9098810` **SECURITY**: `stampEventSigners` resolves signer ONLY from server-trusted
  sources (owner's creator dir → global dir → prior index), never the client
  `entry.creatorFeedSigner`. Airtight: eventId is server-generated
  (`crypto.randomUUID`, events.ts:223) so an attacker can't map a victim's eventId
  to their own signer.

RULE preserved everywhere: siteId is only a POINTER selecting a server-written
index; trust is the index, never the request value (93ea980).

### REMAINING — step 5 (deploy + live test)
1. **Server deploy** (Claude owns): rsync + `docker compose up -d --build server`
   (CLAUDE.md STEP 1). Required before any live test — owner's frontend runs in dev
   against PROD events-api.
2. **Stripe live test is possible after the server deploy alone** — the deployed-site
   bundle ALREADY sends siteId on create-checkout (api/stripe.ts pre-existed); only the
   server needed to consume it (`fcfaace`).
3. **Direct-claim (free/email) from a site** needs the NEW multisite bundle so the
   deployed-site bundle sends siteId on the claim/reserve calls → run STEP 1b
   (`build:multisite` + rsync dist-multisite) AND organisers re-publish. NOT needed for
   the card test.
4. Owner runs a LIVE card payment on a client-signed, deployed (not WoCo-listed) site
   event end-to-end before calling it done.

---


## THE TASK (headline)

SiteBuilder events must be **client-signed** (the organiser owns the event-detail
feed SOC). **Platform-signing should ONLY happen when the user opts to list on the
WoCo app** (global directory). Today they're wrongly conflated.

### The bug (one line, but a money-path tail)
`apps/web/src/lib/creator/events/PublishButton.svelte` ~line 183:

```ts
const feedSigner = (apiUrl || skipAutoList) ? null : await auth.getContentFeedSigner();
```

`skipAutoList` (a *directory opt-out*, set by SiteBuilder) is conflated with the
*signing model*. Because SiteBuilder passes `skipAutoList`, its events are
platform-signed. They should be client-signed.

### Why it was deferred (the real constraint — don't skip this)
The claim + Stripe **money-path** reads the event via a **TRUSTED carrier** to get
price/recipient. This is the `93ea980` fix: `getEvent(signerHint)` is TRUSTED-only
(global directory / server-written `SiteEventsIndex`); never trust a client-supplied
signer (`getEventForDisplay` is the non-caching path for untrusted hints). The global
directory *was* the trusted carrier — so an event NOT in it (skipAutoList) had no
carrier → was kept platform-signed.

The **sites step already built the replacement**: the server-written `SiteEventsIndex`
carries `creatorFeedSigner` (trusted). So a SiteBuilder event CAN be client-signed
**once it's in a site's index**. The missing piece: `claims.ts` / `stripe.ts` call
`getEvent(eventId)` with **no hint**, so they must thread the site carrier.

### Plan
1. **Decouple signing from `skipAutoList`** in `PublishButton`: set `feedSigner` even
   when `skipAutoList` (keep `apiUrl` → still platform-signed; different server batch).
   Keep `skipAutoList` controlling *directory auto-add* only.
2. **Thread the trusted carrier into the money path** so a client-signed,
   not-yet-listed event resolves safely: claim/Stripe `getEvent(eventId)` must use the
   event's site `SiteEventsIndex` `creatorFeedSigner` as the TRUSTED hint (NEVER a
   client request value — keep the `93ea980` rule). Confirm the carrier exists by the
   time a claim can happen (see open question).
3. **Listing on WoCo** (`listOnWoco`): the directory entry already carries
   `creatorFeedSigner` (events step) — verify a client-signed event lists + reads fine.
4. Typecheck (`npx svelte-check --workspace apps/web --threshold error`, ignore the 2
   pre-existing node_modules errors) + `npm run build:server`. **Owner runs a LIVE card
   payment test** (money-path) before calling it done.

### OPEN QUESTION for the owner (ask first)
A SiteBuilder event isn't in a `SiteEventsIndex` until the user picks a site + deploys
(step 2/3). Between creation and deploy there's **no trusted carrier**. Is it
acceptable that an event can't be *claimed* until it's deployed to a site (this is the
real-world flow)? If yes → clean. If claims can happen pre-deploy → need another
trusted carrier.

## SESSION CONTEXT — already fixed + committed on `main` (NOT pushed)

All verified by direct measurement (owner demands certainty — no guessing, measure
server logs / bee directly):
- `91d0e2f` profile avatar image 403 → server now whitelists the `/bytes` ref.
- `d1b0863` profile blanked on nav → stop invalidating the profile cache after writes.
- `79c5efd` multi-chunk content-feed pages upload concurrently (was sequential).
- `5c07b18` **client-SOC bee uploads were SYNCHRONOUS** (missing `Swarm-Deferred-Upload`)
  → blocked publish ~28s. Now deferred (matches legacy feed/bytes writes). This was the
  publish-latency bug. Measured: publish now ~1.2s create + ~7.2s on-chain (register).
- `6270755` profile avatar now STAGES on pick, uploads on Save (was instant-upload +
  wiped the typed name via the form-init effect).
- `7e15d6c` WoCo-list auto-retry (publish→list propagation race → 400, now retries) +
  clearer on-chain progress copy. **No optimistic step 2** (owner rejected it; the ~7s
  on-chain wait is inherent and acceptable).

### Verified facts (don't re-investigate)
- WoCo bee postage batch `9ef3373b…` is HEALTHY (usable, ~21d TTL, util 3/19). Profiles
  + events use it via `/api/swarm/soc` → our Hetzner bee. Etherna batch is ONLY for site
  deploys. Postage is NOT a cause of any bug seen.
- Profile feed write/read works; write signer == read signer (no signer-mismatch bug).
  Earlier "profile gone" was the cache race (fixed) + switching between test passkeys.
- bee sync upload 61ms / deferred 6ms; proxy whitelist 58ms (both fast — not bottlenecks).

## SEPARATE FOLLOW-UP (different task, own chat) — passkey owner-rotation wedge
Memory `project_passkey_owner_rotation_followup`. Passkey account #1 (Kernel
`0x2561d2…`) is WEDGED: 403 "Invalid signature" on every route because the Kernel's
on-chain ECDSA owner (`0x314E06…`) ≠ the live PRF key (a recovery/rekey rotated it).
Fix direction (CTO call, NO 7702): decouple HTTP session-verify from the Kernel — client
signs `AuthorizeSession` with the raw PRF-EOA key (ecrecover, RPC-free), keep
`message.parent = Kernel` for identity/EAS attester; server authorizes via
deterministic `kernelOf(owner)==parent` + on-chain owner-read fallback. NOT the rejected
`c197713` revert (that moved parent→EOA, losing attester==parent). Fresh accounts work;
this only affects rotated/recovered accounts.

## WORKING AGREEMENTS (owner, this session)
- NEVER guess — measure (server logs, direct bee/RPC calls) and be 100% certain before
  claiming a fix. A deployed hypothesis that doesn't move the number is a failure.
- Small, separable commits at each milestone. Owner pushes to GitHub themselves.
- Claude owns SERVER deploys (rsync + `docker compose up -d --build server` to
  the production VM); owner owns frontend `npm run deploy`. Frontend runs
  in dev (`npm run dev:web`) against PROD `events-api.woco-net.com`, so frontend edits
  are live via HMR; server fixes must be deployed to prod to take effect.
- Clean up all temporary instrumentation (revert probes) — leave no debt.
