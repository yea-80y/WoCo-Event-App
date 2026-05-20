# Realignment — 2026-05-18 (v2 — session 2 handover)

Picks up from `REALIGNMENT_2026-05-18.md`. Read that doc first for the
underlying speed-test results, build-order rationale, and Etherna auth
pattern. **This doc only captures session-2 decisions + what's next.**

---

## Session 2 — what shipped (committed)

**`e6d4123` — feat(creator): no-free-events + Stripe-only defaults, buyer-fee floor**

Bundles realignment-doc build steps (1)–(3):

- `packages/shared/src/features.ts` (new): `FEATURES.{freeEventsAllowed,cryptoPaymentsAllowed}` (both `false`), `BUYER_FEE_FLOOR_PCT=4.5`, `BUYER_FEE_DEFAULT_PCT=10`
- `packages/shared/src/event/types.ts`: added `PaymentConfig.buyerFeePercent?: number`
- `apps/web/src/lib/creator/events/TicketSeriesEditor.svelte`:
  - Defaults flipped — `isPaid=true`, `cryptoEnabled=false`, `stripeEnabled=true`
  - "Paid ticket" toggle hidden when `!freeEventsAllowed`
  - Entire crypto block (toggle + chain list) hidden when `!cryptoPaymentsAllowed`
  - New buyer-fee % input (default 10, snaps to 4.5 floor on blur)
  - Fee breakdown rewritten to show: ticket → buyer markup → buyer total → Stripe/platform deductions → payout (per checkout method)
  - Price field marked required (`*`)
- `apps/web/src/lib/creator/events/PublishButton.svelte`: `canPublish` blocks when any series lacks `price > 0` (flag-gated)
- `apps/server/src/routes/events.ts`: defence-in-depth — rejects no-payment / no-stripe / crypto-enabled / sub-floor buyer fee per FEATURES

Build clean: `npm run build:server && npm run build:web`. **Not deployed yet.**

---

## Session 2 — decisions to bake into commit 4

### Batch model (final)

| Scenario | Gateway | Batch |
|---|---|---|
| Website publish, 1st time (no user batch) | Etherna (forced) | **Purchase prompt → new per-user batch** |
| Website publish, 2nd+ (user has batch) | Etherna | Reuse user's batch |
| Event page publish + user already has website batch | Etherna | Reuse user's batch |
| Event page publish + no user batch | Etherna | Shared platform Etherna batch — no prompt |
| Any deploy via WoCo gateway | woco | Platform woco batch (testing escape hatch) |

Key rules:
- Websites = paid tier → always trigger a purchase on first publish
- Events stay free to publish → never trigger a purchase
- One user batch services BOTH their websites and their event pages

### Gateway picker visibility

- **Website builder (`MultiSiteBuilder.svelte`)** — picker visible during testing, defaults Etherna, picking WoCo is a testing escape hatch only. **Hide picker entirely at launch** (Etherna only)
- **Standalone event builder (`SiteBuilder.svelte`)** — picker stays visible, defaults Etherna. Move picker to **step 1** (UX surfaces it up front). Functionally still consumed at deploy time.
- Gateway choice has **zero effect on event creation writes** (event JSON, signed manifests, POD bodies, image) — those always go to platform Bee with platform woco batch. The gateway only determines where the deployed page bundle lives.

### Per-user batch — purchase model

- "Emulated purchase" = real Etherna `/stamps` call (we have free xDai credits), gated only by a confirm-dialog button in the UI. No Stripe step yet — that lands later.
- New endpoint: `POST /api/etherna/purchase-batch` — body `{ depth, ttlDays }`, auth-gated, calls Etherna, writes to registry, returns `{ batchId, expiresAt }`
- Per-user batch defaults:
  - **Testing:** depth 19, TTL 24h (Swarm minimum — bump slightly if Bee rejects)
  - **Production:** depth 19, TTL 30 days
- `+25% PLUR/chunk safety margin` (so batch doesn't run out if Swarm price ticks during TTL) — NOT the same as the script's "$ cap"
- Script-level **per-purchase** $ cap (refuses to call `/stamps` if calculated cost exceeds threshold). Per-purchase guard, NOT aggregate spend ceiling. Renewal cron evaluates each top-up against the same cap.
  - Testing (depth 19, 24h, +25% margin): `$0.50 xDai`
  - Production (depth 19, 30d, +25% margin): `$0.50 xDai`
  - Both expected actual debits are well under (fractions of a cent for 24h; pennies for 30-day per realignment-v1 math).
  - Revisit ONLY when real-world data shows we need more headroom — do not pre-emptively widen.
- Renewal: cron checks `expiresAt - 7d`, tops up if `paidUntil > now`. Stop when `paidUntil < now`.

### Registry shape (existing memory)

`apps/server/.data/etherna-batches.json`:
```
{
  "0xabc...": {
    "batchId": "fc957ecd...",
    "depth": 19,
    "ttlDays": 30,
    "purchasedAt": "2026-05-18T...",
    "expiresAt": "2026-06-17T...",
    "paidUntil": "2027-05-18T...",
    "gateway": "https://gateway.etherna.io"
  }
}
```

File-backed, same pattern as `stripe-accounts.json`, survives restart.

### Env additions

```
ETHERNA_PLATFORM_BATCH=fc957ecd8f3295eb5643fde37e59044445b509a8b77789b8412cbe8c3956bb9a
ETHERNA_USER_BATCH_DEPTH=19
ETHERNA_USER_BATCH_TTL_DAYS=30           # 1 in testing
ETHERNA_USER_BATCH_MARGIN_PCT=25
ETHERNA_PURCHASE_MAX_XDAI=5              # script-level safety cap; 1 in testing
BATCH_PER_USER_AUTO_PROVISION=true
```

---

## Build order — commit 4 (bundle, per Option A)

**Goal:** end-to-end testable Etherna deploy with per-user batch
purchase prompt. Single commit.

### UI

1. `apps/web/src/lib/creator/builder/GatewayPicker.svelte` — un-comment Etherna entry (line 4). Default to Etherna.
2. `apps/web/src/lib/creator/SiteBuilder.svelte` (standalone event):
   - Move `<GatewayPicker>` from step 2 to step 1 (alongside event form)
   - Pass `gatewayUrl` through `/api/site/deploy` (already does — keep)
3. `apps/web/src/lib/creator/builder/MultiSiteBuilder.svelte` (website builder):
   - Add `<GatewayPicker>` to publish/deploy screen — currently missing entirely
   - Pass `gatewayUrl` through `/api/sites/:id/deploy`
4. New `apps/web/src/lib/creator/builder/PurchaseBatchModal.svelte`:
   - Shown when user clicks "Publish website" + Etherna + no user batch
   - Shows: depth, TTL, est. xDai debit (computed client-side via existing chainstate math)
   - "Buy batch" button → calls `POST /api/etherna/purchase-batch`
   - On success → proceed with deploy

### Server — new files

5. `apps/server/src/lib/etherna/batches.ts` — registry:
   - `getUserBatch(addr): UserBatchEntry | null`
   - `saveUserBatch(addr, entry)`
   - `provisionEthernaBatch({ depth, ttlDays, label }): Promise<{ batchId, debit }>` — calls Etherna `/stamps` with hard cap from env
   - File-backed `.data/etherna-batches.json`, atomic write
6. `apps/server/src/lib/etherna/batch-router.ts`:
   - `batchForDeploy({ ownerAddress, gatewayUrl, deployType }): Promise<{ batchId, target: "wocoBee" | "etherna" }>`
   - WoCo gateway → always platform `POSTAGE_BATCH_ID`, target=wocoBee
   - Etherna gateway → user's batch ∥ (event-only fallback to `ETHERNA_PLATFORM_BATCH`)
   - **Throws if** website deploy + Etherna + no user batch + auto-provision disabled — UI should call purchase endpoint first

### Server — endpoints & deploy paths

7. New `apps/server/src/routes/etherna.ts`:
   - `POST /api/etherna/purchase-batch` — auth-gated, body `{ depth, ttlDays }`, calls `provisionEthernaBatch`, writes registry, returns `{ batchId, expiresAt, debit }`
   - `GET /api/etherna/my-batch` — auth-gated, returns user's batch entry or `null`
8. `apps/server/src/routes/site.ts` (standalone-event deploy):
   - Call `batchForDeploy` instead of `requirePostageBatch` directly
   - When target=etherna: upload tar to `https://gateway.etherna.io/bzz` with OAuth (use `ensureEthernaToken` + `getCachedEthernaToken` from existing `apps/server/src/lib/etherna/auth.ts`)
   - Offer-register after upload: `POST /api/v0.3/resources/{ref}/offers`
   - **Inline-SOC feed write** (the locally-patched code already in `sites.ts` lines ~564-588) — port pattern here too if needed for the per-event feed
9. `apps/server/src/routes/sites.ts` (multisite deploy):
   - Same `batchForDeploy` call
   - Add Etherna upload branch
   - Locally-patched inline-SOC fix here already — confirm still present, redeploy

### Env

10. `apps/server/.env.example` — document new vars listed above

### Build / verify

- `npm run build:server && npm run build:web`
- Smoke-test against laptop (no server deploy yet):
  - Standalone event wizard → step 1 picker → publish event → step 2 deploy → no purchase prompt (event flow) → resolves via Etherna
  - Website builder → publish → purchase prompt (first time) → confirm → deploy → resolves via Etherna
  - Second website publish → no prompt → reuses existing batch

---

## Pending after commit 4

- **Commit 5 — deploy to server.** Locally-patched `sites.ts` (inline-SOC) still uncommitted on disk; needs to ride along with the Etherna deploy code. **Then rsync + restart per CLAUDE.md restart procedure (disambiguate by `/proc/PID/cwd` — mf8-server coexists).**
- **Hetzner migration** — user planned same-day; after it lands the server target IP changes from `192.168.0.144`. Re-run speed-test scripts post-migration.
- **Commit 6 — embed widget verification + organiser snippet docs**
- **Commit 7+ — standalone event page deploy expansion** (separate ship doc)
- **Renewal cron** — top up batches 7d before expiry while `paidUntil > now`
- **Real Stripe step** in front of `purchase-batch` — replaces the "emulated" confirm dialog

---

## Carry-over feedback (DO NOT lose)

- **Comments policy** — WHY-only, no paraphrase, no teaching prose (`feedback_comments_policy.md`)
- **Commit cadence** — small revertable commits; surface "commit X before moving on?" rather than piling (`feedback_commit_cadence.md`). Commit 4 is bundled per explicit user request (option A).
- **`mf8-server` coexists on `192.168.0.144`** — DO NOT kill all node/tsx. Disambiguate by `/proc/PID/cwd` (`feedback_mf8_server_coexists.md`)
- **No chained sleeps on deploy verify** — one short health+ps check (`feedback_no_chained_sleeps.md`)
- **bee-js v11** — inline-SOC `uploadPayload()` (≤4096B) NOT `uploadReference()` (breaks Etherna anonymous reads) (`feedback_swarm_feed_upload.md`)
- **bee-js v11 `onRequest`** — passes shallow header copy, mutations don't reach the wire. Workaround: register axios interceptor on bee-js's nested axios (see `project_etherna_integration.md` gotcha #1)
- **Etherna anonymous reads** — `/bytes/{ref}` works after offer, `/feeds/{owner}/{topic}` does NOT (always 401)

---

## Key file map for commit 4

```
NEW
  apps/server/src/lib/etherna/batches.ts
  apps/server/src/lib/etherna/batch-router.ts
  apps/server/src/routes/etherna.ts
  apps/web/src/lib/creator/builder/PurchaseBatchModal.svelte

MODIFY
  apps/web/src/lib/creator/builder/GatewayPicker.svelte
  apps/web/src/lib/creator/SiteBuilder.svelte
  apps/web/src/lib/creator/builder/MultiSiteBuilder.svelte
  apps/server/src/routes/site.ts
  apps/server/src/routes/sites.ts
  apps/server/.env.example

EXISTING (use, don't replace)
  apps/server/src/lib/etherna/auth.ts            # ensureEthernaToken / getCachedEthernaToken
  apps/server/scripts/etherna-test-batch.ts      # reference for /stamps call + chainstate math
  apps/server/scripts/etherna-chainstate.ts      # reference for currentPrice + sizing math
```

---

## Memory pointers (read first in new session)

- `memory/MEMORY.md` (always loaded)
- `memory/project_etherna_integration.md`
- `memory/project_etherna_batch_registry.md`
- `memory/project_etherna_legacy_soc.md`
- `memory/feedback_commit_cadence.md`
- `memory/feedback_mf8_server_coexists.md`
- `memory/feedback_comments_policy.md`
- `memory/feedback_swarm_feed_upload.md`

And then this doc + `docs/REALIGNMENT_2026-05-18.md`.
