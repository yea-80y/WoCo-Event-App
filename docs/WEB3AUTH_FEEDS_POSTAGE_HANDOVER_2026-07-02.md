# Handover — web3auth client feeds + postage batch architecture (2026-07-02)

Branch `feat/feed-signer-recovery`. Two intertwined workstreams. Read with
`FEED_SIGNER_REVIEW_2026-07-02.md` (Fable) and `CLIENT_FEEDS_AUTH_KINDS_HANDOVER.md`.

Test setup: `npm run dev:web` at localhost:5173, but the frontend hits the
**PRODUCTION** API `events-api.woco-net.com`. So client-side edits are live on
localhost; **server-side edits require a deploy** to be exercised.

---

## Workstream A — web3auth client-owned feeds (PRIMARY TASK)

Goal (= Fable lock-down item #2): a web3auth user's client-owned content feeds
(profile now; events already client-signed) must resolve across sign-out/in AND
on a cold device (the cold-device gate). Nothing ships before the gate passes.

### Root causes found this session
1. **Blank profile after re-login / on 2nd browser.** `clearAllAuth()` (logout)
   wipes the feed-signer blob (auth-store `:1524`, "restorable from escrow") — but
   **web3auth escrow is NOT wired** (that's item #3, unbuilt). Re-login never put
   it back, and the passive read resolver (`getContentFeedSignerAddress`) never
   re-derives → profile reads fall back to the empty legacy platform feed → blank.
2. **web3auth refresh = logout.** Web3Auth v10 rehydrates its cached session
   *asynchronously after* `init()` resolves, so `w.connected` reads false the
   instant we check it → `restoreWeb3AuthSession` returned null → clearAllAuth.
3. **"Failed to save profile" 502** was NOT a code bug — the WoCo postage batch
   was full (see Workstream B). Fixed by dilute.

### Fixes applied (UNCOMMITTED, client-side, live on localhost)
- `web3auth-account.ts`: `_awaitRehydration(w)` waits for the cached session to
  settle (event/poll, 5s cap; instant when `!w.cachedConnector`). Used by restore
  + login. Login also recovers from the spurious "User closed the modal" reject.
  Added `[web3auth] restore:` debug log.
- `auth-store.svelte.ts`:
  - `_deriveFeedSignerBySigning` now signs **silently** (no confirm dialog) for
    web3auth/local — it's an internal key-stretch over an in-memory raw key
    (ethers RFC-6979 deterministic). web3 still uses the wallet + double-sign
    check; passkey unchanged.
  - `_establishFeedSignerEagerly()` — re-derives + stores the signer at login AND
    silent-restore for web3auth/local (deterministic → same signer every
    session/device). This is what makes feeds survive the logout-wipe + cold
    devices without escrow. Wired into loginWeb3Auth, loginLocal, and both
    restore branches.
- `main.ts`: dev-only `window.wocoDebug` (public addresses only). Keep for now.
- `ProfilePage.svelte` (isConnected reset key) + `AccountRecoverySetup.svelte`
  (guardian warning copy) — Sonnet's earlier F1/F4 follow-ups.

### Status
- Profile now **persists same-browser** (Chrome sign-out/in) — eager
  re-establishment works.
- **Chromium (2nd browser) still blank** = cold-device gate still failing.

### DECISIVE OPEN TEST (do this first next session)
In BOTH browsers, same web3auth login, run:
```
await wocoDebug.parent()
await wocoDebug.getContentFeedSignerAddress()
```
- parent differs ⇒ logged in as different accounts (test error).
- parent same, signer **differs** ⇒ real bug: derivation not deterministic across
  browsers → investigate Web3Auth key determinism (same login? sapphire_devnet;
  same auth connection?). The signer = keccak(ethers-sig over FEED_SIGNER_DERIVE
  domain); only a non-identical Web3Auth key or non-deterministic sig can diverge.
- both same, still blank ⇒ read/propagation/fallback timing (getProfile self-read
  racing eager establishment; legacy fallback).

NOTE: comparing the raw IndexedDB blob across browsers is a FALSE signal — it's
AES-GCM under a per-browser device key + random IV, so it always differs even when
the key is identical. Only the decrypted address counts.

### After diagnosis
- Fable plan #3: seal `feedSignerPrivKey` + `podSeed` for web3auth into the same
  guardian-escrow bundle passkey users use (align web3auth with the passkey
  recovery backbone). Durability/anti-repoint add-on — NOT the cross-browser fix
  (deterministic re-derivation is). Bundle is already generic.
- Then commit Workstream A + run the full cold-device gate before anything ships.

---

## Workstream B — postage batch architecture

### Live state (2026-07-02)
- **WoCo batch** `9ef3373b…`: **diluted 19→20 today** (tx 0x5022b1f6…), immutable,
  bucketDepth 16, util 8/16, usable. **TTL ~6.3 days** — immutable batch expiry
  GCs ALL its data; **needs a top-up** (owner deferred; not urgent but real).
- **Etherna platform batch** `87cc2df1…` (`woco-platform-30d`): depth 19, util
  3/8, **MUTABLE**, TTL ~16.7 days. Gets event content bytes + deploys when
  Etherna is selected (fallback when the organiser has no user batch).
- Etherna **user batches** (`.data/etherna-batches.json`): all expired (404).

### What ACTUALLY writes to the WoCo batch (full trace — it is the app's primary
data batch, NOT just frontend+directory):
- Platform feeds (`writeFeedPage` → always WoCo): global+creator event directory,
  event detail feeds (non-Etherna), **claims/pending-claims/claimers (attendee
  data)**, profile+avatar feeds (legacy), shop feeds, recovery status+guardian.
- Client SOCs (`/api/swarm/soc` → `uploadSignedSoc` → `requirePostageBatch`,
  ALWAYS WoCo, never routed): client profile SOC, avatar SOC, **event carrier SOC
  (even for Etherna events)**, recovery/portability SOCs.
- Raw bytes (`uploadToBytes` default → WoCo): **avatar image bytes** (heavy;
  immutable ⇒ every re-upload accumulates forever — likely why WoCo filled).
- Only `/api/swarm/bytes` + deploys route via `batchForDeploy` → Etherna.

### Event → directory relationship
Listing = a write to the WoCo directory FEED (`addToEventDirectory`, carries
`creatorFeedSigner`). The event's carrier SOC is what the entry RESOLVES to. The
SOC is on WoCo only because `/api/swarm/soc` hardcodes the platform batch — it
COULD live on Etherna if Etherna resolves SOCs reliably (see Etherna legacy-SOC
concern). Main de-load levers: route client SOCs + avatar images off WoCo; decide
the directory's long-term home.

### Decisions owner is leaning toward
- **Immutable for durable data (events, attendee, profiles) + proactive dilute.**
  Refinement agreed: immutable protects vs eviction but NOT expiry (fund TTL
  regardless); its failure mode is a hard wall (today's outage) → REQUIRES
  utilisation monitoring/alerting + dilute at ~50–60%, not 100%; SEPARATE batches
  per data class so churn can't fill the durable one; do NOT put regenerable
  high-churn data (avatar images, caches) on the durable immutable batch.
- **Dedicated immutable, generously-sized, funded, ENCRYPTED batch for attendee
  CSV/dashboard data** — later, when that feature is built. Swarm is public → PII
  must be encrypted.

### Ops cheatsheet (via server container on the VM)
- Query stamp: `docker compose exec -T server node -e 'fetch(process.env.BEE_URL+"/stamps/<id>").then(r=>r.json()).then(d=>console.log(JSON.stringify(d)))'`
- Dilute: `PATCH ${BEE_URL}/stamps/dilute/<id>/<newDepth>` (immutable batches CAN
  dilute; each dilute ~halves TTL). Returns 202 + txHash; on-chain, ~1 block.
- Etherna stamp: OAuth via `sso.etherna.io/connect/token` (ETHERNA_API_KEY
  `<id>.<secret>`, grant_type=password) → `GET gateway.etherna.io/stamps/<id>`.

---

## Immediate next steps (ordered)
1. Run the DECISIVE OPEN TEST above → determines whether Chromium blank is a
   derivation-divergence bug or a read-timing issue.
2. Fix per the result; commit Workstream A; run the cold-device gate.
3. (Separate) Workstream B de-load design + batch-per-data-class + monitoring.
4. WoCo batch top-up before ~6 days (owner decision).
